import QtQuick
import Quickshell.Io
import qs.Ui
import "Model.js" as Model

// Bar entry point. Owns the daemon connection and hosts Panel.qml, mirroring
// the first-party clock/audio widgets: one manifest kind, panel loaded inside.
BarWidget {
  id: root
  moduleName: "io.github.terrifiedbug.omagram"

  readonly property string glyphLinked: "\uf2c6" // nf-fa-telegram
  readonly property string glyphOffline: "\uf2c6" // nf-fa-telegram

  readonly property string pluginDir: {
    var url = Qt.resolvedUrl(".").toString()
    if (url.indexOf("file://") === 0) url = url.substring(7)
    if (url.length > 1 && url.charAt(url.length - 1) === "/") url = url.substring(0, url.length - 1)
    return decodeURIComponent(url)
  }

  readonly property int unread: client.unread
  readonly property bool linked: client.signedIn
  readonly property bool showCount: root.setting("showUnreadCount", true) === true
  readonly property bool hideWhenEmpty: root.setting("hideWhenEmpty", false) === true

  // Through a `var` property, as elsewhere in the workspace: binding an object
  // literal straight to `environment` trips qmllint's QVariantMap/QVariantHash
  // check.
  readonly property var launcherEnv: ({
    "OMARCHY_OMAGRAM_CLIENT_PATTERN": root.setting("clientPattern", "org.telegram.desktop"),
    "OMARCHY_OMAGRAM_CLIENT_COMMAND": root.setting("clientCommand", "uwsm-app -- Telegram"),
    "OMARCHY_OMAGRAM_WEB_URL": root.setting("webAppUrl", "")
  })

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.anchorItem = button
    panelLoader.item.hostWidget = root
    panelLoader.item.client = client
    panelLoader.item.settings = root.settings
    panelLoader.item.pluginDir = root.pluginDir
  }

  function openClient() {
    clientLauncher.running = true
  }

  // A notification click routes through the daemon, which broadcasts `focus` to
  // every connected panel. Only select here: `omarchy-omagram-focus` asks the
  // shell to open one panel, so opening them all here would pop a panel on
  // every monitor at once.
  function focusChat(chatId) {
    if (!chatId || !panelLoader.item) return
    panelLoader.item.prepareChat(chatId)
    panelLoader.item.open()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  visible: !root.hideWhenEmpty || root.unread > 0 || root.opened

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  OmaGramClient {
    id: client
    pluginDir: root.pluginDir
    socketPath: root.setting("socketPath", "")
    autostartDaemon: root.setting("autostartDaemon", true) === true
    messageLimit: root.setting("messageLimit", 60)
    onFocusRequested: function (chatId) { root.focusChat(chatId) }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  Process {
    id: clientLauncher
    command: [root.pluginDir + "/bin/omarchy-omagram-open"]
    environment: root.launcherEnv
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: {
      var badge = Model.badgeText(root.unread)
      if (root.showCount && badge.length > 0) return root.glyphLinked + " " + badge
      return root.linked ? root.glyphLinked : root.glyphOffline
    }
    active: root.unread > 0
    dimmed: !root.linked
    tooltipText: {
      if (client.needsLogin) return "OmaGram"
      if (root.unread > 0) return "OmaGram \u00b7 " + root.unread + " unread"
      return "OmaGram"
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
      else if (buttonCode === Qt.RightButton) root.openClient()
    }
  }
}
