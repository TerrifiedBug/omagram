pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io

// NDJSON client for the omarchy-omagram daemon over a unix socket.
//
// One instance lives in each BarWidget (so one per monitor). The daemon accepts
// several clients and fans every event out to all of them, which keeps the bar
// panels on separate screens in sync without any cross-window plumbing.
Item {
  id: root

  // Absolute path to the plugin directory, injected by BarWidget so the client
  // can start the daemon without guessing where it was installed.
  property string pluginDir: ""
  property string socketPath: ""
  property bool autostartDaemon: true

  readonly property string defaultSocketPath: {
    var runtime = Quickshell.env("XDG_RUNTIME_DIR")
    return (runtime && runtime.length > 0 ? runtime : "/tmp") + "/omarchy-omagram.sock"
  }
  readonly property string effectiveSocketPath: socketPath && socketPath.length > 0 ? socketPath : defaultSocketPath

  // Live state mirrored from the daemon's `state` frames.
  property bool daemonOnline: false
  property string connectionState: "unknown"
  property bool needsLogin: false
  property bool needsApi: false
  property bool linked: false
  property bool hasQr: false
  property bool codeViaApp: false
  property string passwordHint: ""
  // The daemon pauses QR refresh after its pairing window closes rather than
  // leave an expired code on screen.
  property bool pairingStopped: false
  property int qrVersion: 0
  property string qrPng: ""
  property int unread: 0
  property var me: null
  property string lastError: ""
  property var chats: []
  property int chatsEpoch: 0
  property bool pendingLogin: false

  // Whether the daemon is actually reachable.
  //
  // `Socket.connected` cannot answer this: it reads back `true` while a connect
  // is still pending, so a socket that never reaches the daemon still looks
  // connected. Only the connectionStateChanged signal and inbound frames are
  // trustworthy, so liveness is tracked here instead.
  property bool linkUp: false
  property double lastFrameMs: 0
  // How many messages the daemon loads and replies with when a chat opens.
  // Bound from the plugin setting; the daemon falls back to 60 without it.
  property int messageLimit: 60

  readonly property bool signedIn: linked === true || (needsLogin !== true && (me !== null || (chats && chats.length > 0)))
  readonly property bool ready: signedIn && connectionState === "open"

  signal messagesLoaded(string chatId, var chat, var messages)
  signal messageArrived(string chatId, var message, var chat)
  signal messageStatusChanged(string chatId, string messageId, int status)
  signal messageMedia(string chatId, string messageId, string imagePath)
  signal focusRequested(string chatId)
  signal commandFailed(string command, string message)
  signal sendAcknowledged(string chatId)
  signal buttonPressed(string chatId, string alert, string url)

  function request(payload) {
    var socket = socketLoader.item
    if (!socket || !root.linkUp) return false
    socket.write(JSON.stringify(payload) + "\n")
    socket.flush()
    return true
  }

  function startLogin() {
    root.pendingLogin = true
    if (!root.linkUp) {
      root.startDaemon()
      return false
    }
    return request({ t: "login" })
  }

  function refresh() { request({ t: "refresh" }) }
  function openChat(chatId) { request({ t: "messages", chatId: chatId, limit: root.messageLimit }) }
  function markRead(chatId) { request({ t: "read", chatId: chatId }) }
  function reconnect() { request({ t: "reconnect" }) }
  function logout() { request({ t: "logout" }) }
  function setTyping(chatId, state) { request({ t: "typing", chatId: chatId, state: state }) }
  function setApi(apiId, apiHash) { request({ t: "api", apiId: Number(apiId), apiHash: apiHash }) }
  function sendPassword(password) { request({ t: "password", password: password }) }
  function pressButton(chatId, messageId, row, col) {
    return root.request({ t: "press", chatId: chatId, messageId: messageId, row: row, col: col })
  }

  function setChats(list) {
    root.chats = list || []
    root.chatsEpoch = root.chatsEpoch + 1
  }

  function upsertChatPreview(chat) {
    if (!chat || !chat.chatId) return
    var list = (root.chats || []).slice()
    var i = -1
    for (var n = 0; n < list.length; n++) {
      if (list[n] && list[n].chatId === chat.chatId) {
        i = n
        break
      }
    }
    if (i >= 0) list[i] = chat
    else list.push(chat)
    list.sort(function (a, b) {
      var aPin = a && a.pinned
      var bPin = b && b.pinned
      if (!!bPin !== !!aPin) return bPin ? 1 : -1
      return (b.lastTs || 0) - (a.lastTs || 0)
    })
    root.setChats(list)
  }

  function sendText(chatId, text) {
    if (!chatId || !text || !text.length) return false
    return request({ t: "send", chatId: chatId, text: text })
  }

  property bool setupTried: false

  function startDaemon() {
    if (!pluginDir || pluginDir.length === 0) return
    if (!root.setupTried) {
      root.setupTried = true
      setupRunner.running = true
      return
    }
    daemonStarter.running = true
  }

  // Rebuild the socket from scratch.
  //
  // Toggling `Socket.connected` false→true does not work: the disconnect is
  // applied asynchronously, so the reconnect request is swallowed and the socket
  // stays down forever. Destroying and recreating the object through the Loader
  // gives a fresh QLocalSocket on every attempt.
  function reconnectSocket() {
    socketLoader.active = false
    socketLoader.active = true
  }

  function handleConnectionState(connectedNow) {
    if (!socketLoader.active) return
    if (connectedNow) {
      root.linkUp = true
      root.daemonOnline = true
      root.retryCount = 0
      root.lastFrameMs = Date.now()
      retryTimer.stop()
      root.request({ t: "hello" })
      if (root.pendingLogin) {
        root.pendingLogin = false
        root.request({ t: "login" })
      }
    } else {
      root.linkUp = false
      // A brief socket blip is not "logged out". Retry quietly.
      retryTimer.start()
    }
  }


  // The Socket error enum has no qmllint-visible type, and nothing here reads
  // the code, so the handler takes no parameters.
  function handleSocketError() {
    if (!socketLoader.active) return
    root.linkUp = false
    retryTimer.start()
  }

  function handleLine(line) {
    if (!line || !line.length) return
    root.lastFrameMs = Date.now()
    root.linkUp = true
    try {
      root.handleFrame(JSON.parse(line))
    } catch (e) {
      console.warn("omarchy-omagram: unparseable frame from daemon:", e)
    }
  }

  function handleFrame(frame) {
    switch (frame.t) {
      case "state":
        root.daemonOnline = true
        root.connectionState = frame.connection || "unknown"
        root.needsLogin = frame.needsLogin === true
        root.needsApi = frame.needsApi === true
        root.linked = frame.linked === true
        root.hasQr = frame.hasQr === true
        root.pairingStopped = frame.pairingStopped === true
        root.codeViaApp = frame.codeViaApp === true
        root.passwordHint = frame.passwordHint || ""
        // Path before version: anything reacting to the version bump must
        // already see the matching file.
        root.qrPng = frame.qrPng || ""
        root.qrVersion = frame.qrVersion || 0
        root.unread = frame.unread || 0
        root.me = frame.me || null
        root.lastError = frame.lastError || ""
        if (frame.chats !== undefined) root.setChats(frame.chats || [])
        // Clear the pending flag once the daemon is done trying, not only on
        // success: a rejected api_id or a closed pairing window would otherwise
        // leave the panel stuck on "Getting QR code…".
        if (root.linked || root.hasQr || root.pairingStopped) root.pendingLogin = false
        break

      case "chats":
        root.setChats(frame.chats || [])
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        break

      case "messages":
        root.messagesLoaded(frame.chatId || "", frame.chat || null, frame.messages || [])
        break

      case "message":
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        if (frame.chat) root.upsertChatPreview(frame.chat)
        root.messageArrived(frame.chatId || "", frame.message || null, frame.chat || null)
        break

      case "messageStatus":
        root.messageStatusChanged(frame.chatId || "", frame.id || "", frame.status || 0)
        break

      case "messageMedia":
        root.messageMedia(frame.chatId || "", frame.id || "", frame.imagePath || "")
        break

      case "focus":
        root.focusRequested(frame.chatId || "")
        break

      case "ack":
        if (frame.chatId) root.sendAcknowledged(frame.chatId)
        if (frame.alert || frame.url)
          root.buttonPressed(frame.chatId || "", frame.alert || "", frame.url || "")
        break

      case "error":
        root.commandFailed(frame.for || "", frame.message || "Unknown daemon error")
        break

      case "pong":
        root.daemonOnline = true
        break
    }
  }

  Component {
    id: socketComponent

    Socket {
      path: root.effectiveSocketPath
      connected: true

      parser: SplitParser {
        splitMarker: "\n"
        onRead: function (line) { root.handleLine(line) }
      }

      onConnectionStateChanged: root.handleConnectionState(connected)
      // Quickshell's qmltypes omits QLocalSocket::LocalSocketError and
      // QProcess::ExitStatus, so qmllint cannot resolve these signals'
      // parameter types even when the handler ignores them.
      // qmllint disable signal-handler-parameters
      onError: function () { root.handleSocketError() }
      // qmllint enable signal-handler-parameters
    }
  }

  Loader {
    id: socketLoader
    active: true
    sourceComponent: socketComponent
  }

  // Reconnect loop. Also the daemon autostart hook: a few consecutive failures
  // are treated as "not running" and trigger one launch attempt.
  property int retryCount: 0

  function reset() {
    root.linkUp = false
    root.daemonOnline = false
    root.reconnectSocket()
    retryTimer.start()
  }

  Timer {
    id: retryTimer
    // Capped at 8s: the daemon is a local service, so a long backoff only makes
    // the bar look broken for longer after a restart.
    interval: Math.min(8000, 1200 + root.retryCount * 1000)
    repeat: true
    running: false
    onTriggered: {
      if (root.linkUp) {
        retryTimer.stop()
        return
      }
      root.retryCount += 1
      if (root.retryCount >= 4) root.daemonOnline = false
      if (root.autostartDaemon && root.retryCount === 3) root.startDaemon()
      root.reconnectSocket()
    }
  }

  // A daemon that is wedged rather than gone keeps the socket open while sending
  // nothing. Ping periodically and rebuild the link if the silence gets long.
  Timer {
    id: livenessTimer
    interval: 20000
    repeat: true
    running: true
    onTriggered: {
      if (!root.linkUp) return
      if (root.lastFrameMs > 0 && Date.now() - root.lastFrameMs > 65000) {
        root.reset()
        return
      }
      root.request({ t: "ping" })
    }
  }

  Process {
    id: setupRunner
    command: [root.pluginDir + "/bin/omarchy-omagram-setup"]
    // qmllint disable signal-handler-parameters
    onExited: function () { daemonStarter.running = true }
    // qmllint enable signal-handler-parameters
  }

  Process {
    id: daemonStarter
    command: ["systemctl", "--user", "start", "omarchy-omagram.service"]
    // qmllint disable signal-handler-parameters
    onExited: function (exitCode) {
      // No unit installed (or it failed): fall back to launching the script.
      if (exitCode !== 0) fallbackStarter.running = true
    }
    // qmllint enable signal-handler-parameters
  }

  Process {
    id: fallbackStarter
    command: ["setsid", root.pluginDir + "/bin/omarchy-omagram-daemon"]
    // qmllint disable signal-handler-parameters
    onExited: function () {}
    // qmllint enable signal-handler-parameters
  }

  // Always arm the loop: it stops itself as soon as the link is confirmed up.
  // Plugin disable is handled by the daemon watching shell.json — do not stop
  // the shared user service from Component.onDestruction (fires on every bar
  // rebuild / monitor teardown, not only on disable).
  Component.onCompleted: retryTimer.start()
}
