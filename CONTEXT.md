# Better GitHub Feed

Better GitHub Feed turns the activity of the developers an app user follows on GitHub into a unified, filterable feed.

## Language

**GitHub Following**:
The authoritative set of GitHub accounts that an app user follows. Membership is determined only by GitHub, not locally.
_Avoid_: Subscription, local following list

**Following Sync**:
The reconciliation that replaces the app's known GitHub Following with GitHub's authoritative set. A failed sync leaves the previously known set unchanged.
_Avoid_: Subscription sync, incremental follow update

**GitHub Activity**:
An event emitted by a GitHub account. It belongs to that GitHub account and is shared across every app user who follows the account.
_Avoid_: User-owned activity, per-user activity

**Feed Refresh**:
The retrieval of a GitHub account's recent activity into the shared feed. It adds previously unseen GitHub Activity and does not treat GitHub's recent activity response as a complete history.
_Avoid_: Feed replacement, activity snapshot

**User Filter**:
A named rule owned by an app user that matches GitHub Activity the user wants hidden from their feed.
_Avoid_: Inclusion filter, feed query

**Visible Feed**:
The GitHub Activity from an app user's GitHub Following that does not match any of the user's User Filters.
_Avoid_: Filter matches, raw feed
