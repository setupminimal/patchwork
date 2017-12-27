var nest = require('depnest')
var {Value, Proxy, Array: MutantArray, h, computed, when, onceTrue, throttle, resolve} = require('mutant')
var pull = require('pull-stream')
var Abortable = require('pull-abortable')
var Scroller = require('../../../lib/scroller')
var nextStepper = require('../../../lib/next-stepper')
var extend = require('xtend')
var paramap = require('pull-paramap')

var bumpMessages = {
  'vote': 'liked this message',
  'post': 'replied to this message',
  'about': 'added changes',
  'mention': 'mentioned you',
  'channel-mention': 'mentioned this channel'
}

// bump even for first message
var rootBumpTypes = ['mention', 'channel-mention']

exports.needs = nest({
  'about.obs.name': 'first',
  'app.sync.externalHandler': 'first',
  'message.html.canRender': 'first',
  'message.html.render': 'first',
  'message.sync.isBlocked': 'first',
  'message.sync.unbox': 'first',
  'message.sync.timestamp': 'first',
  'profile.html.person': 'first',
  'channel.html.link': 'first',
  'message.html.link': 'first',
  'message.sync.root': 'first',
  'feed.pull.rollup': 'first',
  'feed.pull.withReplies': 'first',
  'feed.pull.unique': 'first',
  'sbot.async.get': 'first',
  'keys.sync.id': 'first',
  'intl.sync.i18n': 'first',
  'intl.sync.i18n_n': 'first',
  'message.html.missing': 'first'
})

exports.gives = nest({
  'feed.html.rollup': true
})

exports.create = function (api) {
  const i18n = api.intl.sync.i18n
  const i18nPlural = api.intl.sync.i18n_n
  return nest('feed.html.rollup', function (getStream, {
    prepend,
    rootFilter = returnTrue,
    bumpFilter = returnTrue,
    compactFilter = returnFalse,
    prefiltered = false,
    displayFilter = returnTrue,
    updateStream, // override the stream used for realtime updates
    waitFor = true
  }) {
    var updates = Value(0)
    var yourId = api.keys.sync.id()
    var throttledUpdates = throttle(updates, 200)
    var updateLoader = h('a Notifier -loader', { href: '#', 'ev-click': refresh }, [
      'Show ', h('strong', [throttledUpdates]), ' ', plural(throttledUpdates, i18n('update'), i18n('updates'))
    ])

    var abortLastFeed = null
    var content = Value()
    var loading = Proxy(true)
    var unreadIds = new Set()
    var newSinceRefresh = new Set()
    var highlightItems = new Set()

    var container = h('Scroller', {
      style: { overflow: 'auto' },
      hooks: [(element) => {
        // don't activate until added to DOM
        refresh()

        // deactivate when removed from DOM
        return () => {
          if (abortLastFeed) {
            abortLastFeed()
            abortLastFeed = null
          }
        }
      }]
    }, [
      h('div.wrapper', [
        h('section.prepend', prepend),
        content,
        when(loading, h('Loading -large'))
      ])
    ])

    onceTrue(waitFor, () => {
      // display pending updates
      pull(
        updateStream || pull(
          getStream({old: false}),
          LookupRoot()
        ),
        pull.filter((msg) => {
          // only render posts that have a root message
          var root = msg.root || msg
          return root && root.value && root.value.content && rootFilter(root) && bumpFilter(msg, root) && displayFilter(msg)
        }),
        pull.drain((msg) => {
          if (msg.value.content.type === 'vote') return
          if (api.app.sync.externalHandler(msg)) return

          // Only increment the 'new since' for items that we render on
          // the feed as otherwise the 'show <n> updates message' will be
          // shown on new messages that patchwork cannot render
          if (canRenderMessage(msg) && msg.value.author != yourId && (!msg.root || canRenderMessage(msg.root))) {
              newSinceRefresh.add(msg.key)
              unreadIds.add(msg.key)
          }

          if (updates() === 0 && msg.value.author === yourId && container.scrollTop < 20) {
            refresh()
          } else {
            updates.set(newSinceRefresh.size)
          }
        })
      )
    })

    var result = MutantArray([
      when(updates, updateLoader),
      container
    ])

    result.pendingUpdates = throttledUpdates
    result.reload = refresh

    return result

    function canRenderMessage (msg) {
      return api.message.html.canRender(msg)
    }

    function refresh () {
      onceTrue(waitFor, () => {
        if (abortLastFeed) abortLastFeed()
        updates.set(0)
        content.set(h('section.content'))

        var abortable = Abortable()
        abortLastFeed = abortable.abort

        highlightItems = newSinceRefresh
        newSinceRefresh = new Set()

        var done = Value(false)
        var stream = nextStepper(getStream, {reverse: true, limit: 50})
        var scroller = Scroller(container, content(), renderItem, {
          onDone: () => done.set(true),
          onItemVisible: (item) => {
            if (Array.isArray(item.msgIds)) {
              item.msgIds.forEach(id => {
                unreadIds.delete(id)
              })
            }
          }
        })

        // track loading state
        loading.set(computed([done, scroller.queue], (done, queue) => {
          return !done && queue < 5
        }))

        pull(
          stream,
          abortable,
          pull.filter(msg => msg && msg.value && msg.value.content),
          prefiltered ? pull(
            pull.filter(msg => !api.message.sync.isBlocked(msg)),
            pull.filter(rootFilter),
            api.feed.pull.unique(),
            api.feed.pull.withReplies()
          ) : pull(
            pull.filter(bumpFilter),
            api.feed.pull.rollup(rootFilter)
          ),
          scroller
        )
      })
    }

    function renderItem (item, opts) {
      var partial = opts && opts.partial
      var meta = null
      var previousId = item.key

      var groupedBumps = {}
      var lastBumpType = null

      var rootBumpType = bumpFilter(item)
      if (rootBumpTypes.includes(rootBumpType)) {
        lastBumpType = rootBumpType
        groupedBumps[lastBumpType] = [item]
      }

      item.replies.forEach(msg => {
        var value = bumpFilter(msg)
        if (value) {
          var type = typeof value === 'string' ? value : getType(msg)
          ;(groupedBumps[type] = groupedBumps[type] || []).unshift(msg)
          lastBumpType = type
        }
      })

      var replies = item.replies.filter(isReply).sort(byAssertedTime)
      var highlightedReplies = replies.filter(getPriority)
      var replyElements = replies.filter(displayFilter).slice(-3).map((msg) => {
        var result = api.message.html.render(msg, {
          previousId,
          compact: compactFilter(msg, item),
          priority: getPriority(msg)
        })
        previousId = msg.key

        return [
          // insert missing message marker (if can't be found)
          api.message.html.missing(last(msg.value.content.branch), msg),
          result
        ]
      })

      var renderedMessage = api.message.html.render(item, {
        compact: compactFilter(item),
        includeForks: false, // this is a root message, so forks are already displayed as replies
        priority: getPriority(item)
      })

      unreadIds.delete(item.key)

      if (!renderedMessage) return h('div')

      if (rootBumpType === 'matches-channel') {
        var channels = []
        if (item.value.content.channel) channels.push(item.value.content.channel)
        if (item.filterResult && Array.isArray(item.filterResult.matchingTags)) {
          item.filterResult.matchingTags.forEach(x => channels.push(x))
        }
        meta = h('div.meta', [
          many(channels, api.channel.html.link, i18n), ' ', i18n('mentioned in your network')
        ])
      } else if (lastBumpType) {
        var bumps = lastBumpType === 'vote'
          ? getLikeAuthors(groupedBumps[lastBumpType])
          : getAuthors(groupedBumps[lastBumpType])

        if (lastBumpType === 'matches-channel' && item.value.content.channel) {
          var channel = api.channel.html.link(item.value.content.channel)
          meta = h('div.meta', [
            i18nPlural('%s people from your network replied to this message on ', groupedBumps[lastBumpType].length), channel
          ])
        } else {
          var description = i18n(bumpMessages[lastBumpType] || 'added changes')
          meta = h('div.meta', [
            many(bumps, api.profile.html.person, i18n), ' ', description
          ])
        }
      }

      // if there are new messages, view full thread goes to the top of those, otherwise to very first reply
      var anchorReply = highlightedReplies.length >= 3 ? highlightedReplies[0] : replies[0]

      var result = h('FeedEvent -post', {
        attributes: {
          'data-root-id': item.key
        }
      }, [
        meta,
        renderedMessage,
        when(replies.length > replyElements.length || partial,
          h('a.full', {href: item.key, anchor: anchorReply && anchorReply.key}, [i18n('View full thread') + ' (', replies.length, ')'])
        ),
        h('div.replies', replyElements)
      ])

      result.msgIds = [item.key].concat(item.replies.map(x => x.key))

      return result
    }

    function channelLink (channelName) {
      return
    }

    function getPriority (msg) {
      if (highlightItems.has(msg.key)) {
        return 2
      } else if (unreadIds.has(msg.key)) {
        return 1
      } else {
        return 0
      }
    }
  })

  function LookupRoot () {
    return paramap((msg, cb) => {
      var rootId = api.message.sync.root(msg)
      if (rootId) {
        api.sbot.async.get(rootId, (_, value) => {
          if (value && typeof value.content === 'string') {
            // unbox private message
            value = api.message.sync.unbox(value)
          }
          cb(null, extend(msg, {
            root: {key: rootId, value}
          }))
        })
      } else {
        cb(null, msg)
      }
    })
  }

  function byAssertedTime (a, b) {
    return api.message.sync.timestamp(a) - api.message.sync.timestamp(b)
  }
}

function plural (value, single, many) {
  return computed(value, (value) => {
    if (value === 1) {
      return single
    } else {
      return many
    }
  })
}

function many (ids, fn, intl) {
  ids = Array.from(ids)
  var featuredIds = ids.slice(0, 4)

  if (ids.length) {
    if (ids.length > 4) {
      return [
        fn(featuredIds[0]), ', ',
        fn(featuredIds[1]), ', ',
        fn(featuredIds[2]), intl(' and '),
        ids.length - 3, intl(' others')
      ]
    } else if (ids.length === 4) {
      return [
        fn(featuredIds[0]), ', ',
        fn(featuredIds[1]), ', ',
        fn(featuredIds[2]), intl(' and '),
        fn(featuredIds[3])
      ]
    } else if (ids.length === 3) {
      return [
        fn(featuredIds[0]), ', ',
        fn(featuredIds[1]), intl(' and '),
        fn(featuredIds[2])
      ]
    } else if (ids.length === 2) {
      return [
        fn(featuredIds[0]), intl(' and '),
        fn(featuredIds[1])
      ]
    } else {
      return fn(featuredIds[0])
    }
  }
}

function getAuthors (items) {
  return items.reduce((result, msg) => {
    result.add(msg.value.author)
    return result
  }, new Set())
}

function getLikeAuthors (items) {
  return items.reduce((result, msg) => {
    if (msg.value.content.type === 'vote') {
      if (msg.value.content && msg.value.content.vote && msg.value.content.vote.value === 1) {
        result.add(msg.value.author)
      } else {
        result.delete(msg.value.author)
      }
    }
    return result
  }, new Set())
}

function isReply (msg) {
  if (msg.value && msg.value.content) {
    var type = msg.value.content.type
    return type === 'post' || (type === 'about' && msg.value.content.attendee)
  }
}

function getType (msg) {
  return msg && msg.value && msg.value.content && msg.value.content.type
}

function returnTrue () {
  return true
}

function returnFalse () {
  return false
}

function last (array) {
  if (Array.isArray(array)) {
    return array[array.length - 1]
  } else {
    return array
  }
}
