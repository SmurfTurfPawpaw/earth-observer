# Hosting boundaries

The production service serves only `dist/` and explicitly registered provider
routes. Credentials belong in server environment variables. There is no
runtime key editor, arbitrary camera pack, browser-local tool server, or
credential discovery. Provider URLs are fixed or validated against allowlists.

Deploy behind HTTPS, maintain Node and dependencies, and apply ingress limits
appropriate to your audience and provider quotas. Set trusted proxy addresses
only for your controlled ingress. Cache contents are public feed data; preserve
CelesTrak's stop marker until the underlying provider issue has been resolved.

Please report exploitable defects privately to the repository owner before
publishing details. Include the affected commit and a minimal reproduction.
