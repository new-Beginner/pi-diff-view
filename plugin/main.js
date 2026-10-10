/**
 * Diff view — PI-Desktop plugin entry.
 *
 * The host injects the global `pi` object. Every call is gated by the
 * permissions declared in manifest.json, so widening what this file does
 * usually means widening `permissions` too.
 */

async function onLoad() {
  await pi.commands.register({
    id: "plugin.open",
    title: "Diff view: Open Panel",
    keywords: ["plugin"],
    run: async () => {
      await pi.ui.openPanel({ title: "Diff view" });
      await pi.ui.showToast("Hello from Diff view");
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("plugin.open");
}

module.exports = { onLoad, onUnload };
