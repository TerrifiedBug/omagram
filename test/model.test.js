const test = require("node:test")
const assert = require("node:assert/strict")

const Model = require("../Model.js")

test("badgeText formats unread totals", () => {
  assert.equal(Model.badgeText(0), "")
  assert.equal(Model.badgeText(5), "5")
  assert.equal(Model.badgeText(150), "99+")
})

test("statusGlyph distinguishes sent and read messages", () => {
  assert.equal(Model.statusGlyph(2), "\uf00c")
  assert.equal(Model.statusGlyph(4), "\uf00c\uf00c")
})

test("chatTitle falls back to the Telegram peer kind", () => {
  assert.equal(Model.chatTitle({ name: "", kind: "user" }), "User")
  assert.equal(Model.chatTitle({ name: "", kind: "group" }), "Group")
  assert.equal(Model.chatTitle({ name: "", kind: "channel" }), "Channel")
})

test("chatSubtitle identifies a forum topic's group", () => {
  assert.equal(Model.chatSubtitle({ name: "General", group: "Release crew", topicId: 1 }), "Release crew")
  assert.equal(Model.chatSubtitle({ name: "Alice", group: "", kind: "user" }), "")
  assert.equal(Model.chatSubtitle({ name: "Older chat", kind: "user" }), "")
})
