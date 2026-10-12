# Retained GDACS notice layer

This slice displays a current, retained seven-day notice sample from the existing
bounded GDACS collection. It adds no provider request, collector, schema or writer.
It is not a complete disaster archive, independently confirmed incident dataset
or affected-area map.

## Source and identity

The [official API quick start](https://data.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf)
permits API access and requests acknowledgement as "Global Disaster Alert and
Coordination System, GDACS". The [source disclaimer](https://gdacs.org/About/termofuse.aspx)
qualifies modelled/automatic notifications, uncertain accuracy and completeness,
and their relationship to official national alerts. Preserve that acknowledgement
and each original report link. No linked article, photograph or report body is
copied by this slice.

Identity preserves GDACS event type, event ID and episode ID. Different episodes
are separate notices, not a count of unique physical disasters. Official report
URLs must bind that exact identity. Original retained source dates and alert fields
remain literal. A source interval end date does not confirm physical completion.
Missing geometry remains unmapped; an indicative point is not an impact boundary.

## Stored delivery and evidence

Only GET /api/world/source-items?source=gdacs is admitted, also under the deployed
/earth/ mount. No historical date, limit, arbitrary source URL or object key input
is accepted. The complete result is capped at 100 notices and 256 KiB, with a
10-second deadline and at most one whole-cohort retry after an edition change.
Missing or corrupted retained evidence returns unavailable, never a provider
fallback or a partial cohort presented as complete.

The reader binds the current source pointer to its completed capture, historical
membership count, immutable normalized object and indexed source revisions. It
recomputes identity, factual revisions, snapshot digest, body digest and completed
edition version. It reads one whole cohort object per attempt, rather than an
original object for every unchanged notice.

Current cohort citations are validated. Earlier factual origin references remain
separate and explicitly index-only, bodyValidated=false. Normalized retained
metadata is not claimed to be the raw original provider response. Cohort capture,
database publication, literal record retrieval and browser read/cache clocks remain
distinct. Operational source checks are not bound to this receipt, so freshness
status is unknown rather than substituting the host response date.

## Browser and time

The optional layer imports only when enabled. It reconciles entities by stable
notice identity so unchanged and corrected notices retain selection. Only admitted
finite coordinates create visible markers. The existing selection workspace shows
one source dossier, with technical evidence folded away by default.

One bounded validated device cache may paint through the same cancellation owner
as its fresh stored GET. A collection stream event is only a wake for a new read;
it is not a GDACS edition fence. It aborts the old active read and suppresses cached
callbacks until fresh evidence validates. No extra EventSource or browser provider
request is introduced.

The existing manager suspends this current-only layer in History. Absent current
membership removes a marker without asserting withdrawal or completion. A future
historical lane must retain and replay genuine dated GDACS membership and revisions
under its own coverage contract before these notices can appear in a past scene.
