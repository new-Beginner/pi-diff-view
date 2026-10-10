# Review UI design contract

Mission: inspect local and captured-turn changes accurately, then comment or explicitly confirm a narrowly scoped operation. No inferred snapshots, sessions, or send capability.

Tokens: system UI 13px/1.45; code ui-monospace 12px/20px. Light canvas #ffffff, surface #f6f7f8, ink #20252b, divider #dce1e6, focus #2469ce; dark canvas #181b20, surface #20242b, ink #e5e9ef, divider #363d47, focus #8cb9ff. Additions green (#18723b/#8bddab), deletions red (#b02c35/#ffa0a8). Spacing 4/8/12/16/24px; controls radius 4px, dialog 8px. Feedback immediate; disclosure entrance 140ms cubic-bezier(.2,.9,.3,1), no decorative motion; reduced motion removes entrances.

Layout: repo/scope toolbar above searchable file rail and a stable minmax(0,1fr) review pane. Paths, counts, side-specific line numbers and thin dividers carry hierarchy. On narrow panels the file rail becomes a bounded row above the review pane; toolbars wrap rather than truncate controls. Diff rows scroll horizontally only when wrap is off.

Do: native-density controls, visible focus, green/red plus explicit +/- symbols, Chinese/English labels, actual backend error messages, bounded pages (80 source rows), explicit target confirmations, stale annotation warnings. Don't: hero/pricing/cards, fake snapshots, hidden overflow to conceal layout defects, absent-action buttons, hunk operations with expanded context, double titlebar offsets, auto-send or async composer insert.

Assumptions: bootstrap is authoritative for roots/runs/settings/appearance; context `-1` means full (backend contract); pagination is by source diff rows, including pages that continue a hunk; host React and ReactDOM are supplied externally to the renderer build. Standalone panels have no composer insertion. Reply layers have a fixed explicit session and insert only preloaded feedback on a synchronous user click. UI fixtures are explicitly demo data; host behavior must be verified separately in PI-Desktop 0.17.0.
