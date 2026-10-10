## 0.15

Grove tells you which Claude Code agents need you, and gets you to them. 0.15 adds a screen for what they used.

New:

- **Usage**, under All sessions in the sidebar (`⌘3`, or `⌘K`): API-equivalent cost, agent time and tokens for the last
  week, month or year, with the change against the range before
- one chart, bars stacked by project in each project's own colour. a click on a tile picks what it measures, and
  pointing at a bar says its split
- under it the same range by project and by model, and sessions, subagents, cache hit rate, the most agents working at
  once and the longest single turn
- the cost is what the same tokens would cost on the API at list prices, priced by Grove from the transcripts. on a
  plan you are not billed this way
- agent time counts every agent: three subagents working ten minutes at once is thirty minutes
- the numbers stay when Claude Code deletes an old transcript, so the year view fills in over the year
- the first launch reads every transcript once to count it. the screen says how far it has got

None of the numbers show anywhere but on the Usage screen.

Also new: the app icon. Three glass trees on violet, white for the session that needs you. On macOS 26 the system
draws the glass itself, and the icon follows the Dark, Clear and Tinted icon styles. The menu bar mark is the same
three trees.

The [README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not
verified.
