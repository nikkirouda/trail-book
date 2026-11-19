# Trail Book

A private, offline companion for a long walk: the day's plan, stops, a daily log, a pace check, a
gear checklist, safety notes and an emergency page.

**This repository is code only.** It contains no plan, no dates, no names and no log. Those live in a
separate private repository. The app fetches them once with a key the owner pastes in, keeps them on
the device, and then works with no signal.

- No dependencies, no build step, no third-party requests. The only network address it talks to is
  the GitHub API, for the owner's private repository.
- Everything fetched is treated as data: reduced to expected types, escaped before display, under a
  strict Content-Security-Policy.
- Position, sun times and pace are aids, not instruments. Carry a paper map.
