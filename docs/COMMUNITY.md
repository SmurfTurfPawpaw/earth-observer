# Community contributions

Private notebook records remain in browser storage. The notebook's separate **Community contributions** section loads only when opened. Browsing is public. Submitting for review requires Sites sign-in, a public display alias, a description, and two explicit confirmations: consent to publication and rights to share the material. There is no automatic upload of notebook records or automatic publication.

## Hosting configuration

The production handler must run behind Sites dispatch. Only that dispatch's trusted `oai-authenticated-user-id` identifies the signed-in contributor. The handler does not accept an account ID from form fields, a generic user header, or an email header. Do not expose a direct origin that lets clients inject the trusted identity header. Local Node development does not provide Sites identity.

Bind the existing private R2 store as `EARTH_STORE`. Configure a cryptographically random `EARTH_MODERATION_KEY` (32–256 characters) through the host's secret configuration. Keep it server-side and in the operator's secret manager; it is never a browser variable or source-code value. An absent/invalid key disables submissions and moderation. Public reading of already approved material can remain available.

The runtime mounts `handleEvidence` before provider middleware under `/api/evidence`. The personal-site deployment maps those API requests into `/earth/api/evidence` and normalizes the internal path. The browser uses the same-origin API. The Sites sign-in link is an ordinary `_top` navigation to `/signin-with-chatgpt?return_to=…`; its return path preserves `/earth/` and the selected view. The application does not implement or fetch that authentication route.

## Review workflow

Supply the key through `EARTH_MODERATION_KEY` in the operator process, or pipe it from a secret manager into standard input. Never pass a key as a command argument. The tool sends it only in a Bearer authorization header, rejects redirects and public HTTP hosts, and does not print it.

```powershell
node scripts/evidence-moderate.mjs https://giovannicallebaut.com/earth/ list
node scripts/evidence-moderate.mjs https://giovannicallebaut.com/earth/ photo REFERENCE review-photo.jpg
node scripts/evidence-moderate.mjs https://giovannicallebaut.com/earth/ approve REFERENCE
node scripts/evidence-moderate.mjs https://giovannicallebaut.com/earth/ reject REFERENCE
node scripts/evidence-moderate.mjs https://giovannicallebaut.com/earth/ unpublish REFERENCE
```

`list` returns at most 20 pending records and an optional `nextCursor`; pass that cursor as the last argument to retrieve the next page. `photo` downloads the private pending image through moderator authentication and refuses to overwrite an existing local file. The UUID reference comes from the queue, not a contributor account ID. No contributor identity grants moderator rights.

Before approval, inspect the text, source link, date, selected coordinates, depicted scene, rights and private information. Open the downloaded image to confirm that it decodes. A structural JPEG check cannot determine the scene's authenticity or publication rights. Review authorizes publication; public cards continue to say **not independently verified**. A failed/interrupted moderation response may leave the action's result uncertain; inspect the queue and public list before retrying.

Rejecting removes the pending metadata and image. Approval copies the checked image and public metadata, then removes the private pending copies and account ID. Unpublishing removes the public record and image. Previously fetched public responses have a maximum cache lifetime of 60 seconds; deleting server objects does not erase copies someone has already saved.

## API and limits

| Route | Admission and behavior |
| --- | --- |
| `GET /api/evidence/session` | Only sign-in/configuration booleans and the photo size limit; no identity is returned. |
| `GET /api/evidence` | Paginated approved contributions only. Account IDs and consent records are omitted. |
| `GET, HEAD /api/evidence/:reference/photo` | A matching published record must exist. Pending assets return 404. |
| `POST /api/evidence/submissions` | Trusted signed-in identity, same-origin multipart form and both consents. Returns 202/pending. |
| `GET /api/evidence/moderation` | Separate moderator secret; pending list excludes account IDs. |
| `GET, HEAD /api/evidence/moderation/:reference/photo` | Moderator secret plus a pending record; private image response is never cached. |
| `POST /api/evidence/moderation/:reference` | Moderator secret and bounded JSON `action`: approve, reject or unpublish. |

Photographs are decoded and re-encoded in the browser at up to 1280 pixels, stripping their original metadata and filename. The server accepts only a restrictive JPEG profile, at most 2 MB and 2048×2048 pixels. It rejects APP1/EXIF, other non-JFIF application metadata, comments, thumbnails, malformed segment/scan boundaries, truncation and trailing payloads. It checks the stored SHA-256 again at approval. This verifies accepted structure and unchanged bytes, not the depicted event.

Descriptions are limited to 5000 characters, titles to 160 and aliases to 40. Aliases cannot be email addresses. Source links must be public HTTP(S) URLs without credentials or literal/private host names. The server does not fetch contributor source links. Optional map coordinates are rounded to three decimals and labeled contributor-selected; they are not extracted from a photo. Optional observation time is contributor-reported; submitted/published times are server timestamps.

Each account may submit up to 5 records per UTC day with 60 seconds between submissions. The site accepts at most 25 submissions per day and holds at most 100 pending and 500 published records. The runtime also has a separate IP request guard. R2 keys use `evidence/`; they do not share provider cache prefixes. Rate claims use conditional R2 writes, and identity collisions cannot replace or delete another submission's photograph. Moderation is manual; no automatic review, user appeal dashboard, cross-device notebook sync or blanket authenticity claim is included.

## Validation

`npm test` discovers the worker and UI policy/lifecycle tests. They cover anonymous and impostor identity rejection, missing configuration, cross-site requests, explicit consents, source/alias validation, JPEG metadata and size failures, pending/public isolation, wrong moderator secrets, integrity failures, rejection/unpublishing, submission bounds and identity collisions. UI tests verify no fetch before open, obsolete completions ignored after close, processed JPEG bytes only, and no public card added for a pending receipt.
