# 0004: Recent history is a continuous lookback of N business dates

- Status: Accepted
- Date: 2026-09-26
- Roadmap: section 4.2

## Context

Every commit from "the last N business days" must stay visible. Without a precise
definition, weekends, today's partial day, time zones, and daylight-saving changes
each allow several reasonable readings, and tests would disagree about which
commits belong.

## Decision

With a configured N (default 2), weekday set (default Monday–Friday), and IANA
time zone:

1. Capture one `now` for the whole graph build, in the configured time zone.
2. Walk backward from today's local date, collecting business dates. Today counts
   if it is a business date. Stop after N dates.
3. The window is `[local midnight at the start of the oldest collected date, now]`,
   compared against **committer** time.
4. Non-business dates inside the window are included. The window is continuous;
   it does not hide weekend work.

For N=2 and Monday–Friday: on Tuesday the window starts Monday 00:00; on Monday it
starts Friday 00:00; on Saturday or Sunday it starts Thursday 00:00.

Use calendar arithmetic, not N×24 hours, so DST transitions are exact. Reject
N<1, non-integers, empty or unknown weekday sets, and invalid time zones. Holidays
are not inferred.

Membership comes from filtering a full topology index. Traversal must not stop at
an old timestamp, because committer dates are not monotonic along parent edges.

## Consequences

- The window moves at local midnight even when no refs change, so the monitor
  must recompute on a clock schedule and after sleep/resume or clock changes.
- Commits pushed today but authored or committed long ago are not "recent"; the
  UI must say the window measures commit time, not push time.
- Graph selection needs an injectable clock and time zone for tests. Demo fixture
  dates (weeks of 2026-09-14 and 2026-09-21, EDT) are chosen to exercise this.

## Revisit

If users need holiday calendars, or if author time proves more useful than
committer time in practice.
