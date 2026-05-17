# Migrating from v1 to v2

A guide for teams moving from API v1 to API v2. Includes key differences, breaking changes, and refactoring recommendations.

## Introduction

Productboard API v2 is the next generation of our public API — designed from the ground up to be more consistent, more flexible, and more efficient than v1. Whether you're maintaining an existing integration or planning a new one, this guide will walk you through what's changing, what's staying the same, and how to make the transition smoothly.

### Why API v2

API v1 was built incrementally over time, which led to inconsistencies across endpoints and gaps in coverage. API v2 addresses this with a unified design: predictable endpoint patterns, configuration-driven schemas, and new capabilities — all built around standard RESTful conventions. The result is an API that's easier to learn, faster to integrate with, and requires fewer calls to get the data you need.

### What stays the same

Not everything is changing. These foundational aspects of the API work the same way in v2:

* **[Authentication](/v2.0.0/reference/authentication)** — same auth mechanism, no changes required
* **[Rate limits](/v2.0.0/reference/rate-limits)** — same limits and behavior
* **[Richtext formatting](/v2.0.0/reference/richtext)** — same format for richtext fields

If your integration already handles these, that code carries over as-is.

## Key Changes in API v2

API v2 isn't just a version bump — it's a redesign of how the API works. Here are the most important changes you'll encounter when migrating from v1.

### Configuration-based API

In v1, figuring out which fields an entity supported often required multiple API calls, or digging through documentation. API v2 introduces [configuration endpoints](/v2.0.0/reference/configuration-endpoint) that describe this for you. You can query the configuration for any [entity](/v2.0.0/reference/listentityconfigurations) or [note](/v2.0.0/reference/listnoteconfigurations) type to get a full list of available fields, their types, and the [filters you can use](/v2.0.0/reference/configuration-endpoint#working-with-filters). No more brittle data models — your integration can discover what's available at runtime.

### Unified entity endpoint

v1 grew organically, which meant different entity types had different endpoint structures and different levels of support. Some entities couldn't be deleted; others had inconsistent field behavior. v2 replaces this patchwork with a [single, consistent endpoint pattern](/v2.0.0/reference/listentities) that covers all entity types — products, components, features, subfeatures, initiatives, objectives, key results, releases, release groups, users, and companies. Every entity type supports the same set of operations: Create, List, Retrieve, Update, and Delete. And all fields and values are returned by default, so you don't need extra calls to get the full picture.

### Relationship endpoints

Connecting entities and notes in v1 required indirect approaches — often involving multiple calls or workarounds to piece together how objects related to each other. v2 introduces dedicated relationship endpoints for both [entities](/v2.0.0/reference/listentityrelationships) and [notes](/v2.0.0/reference/listnoterelationships), giving you a direct way to traverse the graph of connections between objects. You can list, create, and remove relationships in a straightforward, predictable way.

### No X-Version header required

A small quality-of-life improvement: v1 required an `X-Version` header on every request. In v2, you just call the endpoint directly — no version header needed. One less thing to configure, one less thing to debug.

### New features

v2 also brings capabilities that didn't exist in v1:

* **[Analytics](/v2.0.0/reference/listmemberactivities), [Teams](/v2.0.0/reference/listteams), and [Members](/v2.0.0/reference/listmembers)** — new endpoints for accessing team structures and member activity data
* **[Response field control](/v2.0.0/reference/response-field-control)** — use the `fields` query parameter to request only the fields you need, reducing payload size and improving performance
* **Powerful search capabilities** - [search entities](/reference/performentitiessearch) by the value of default and custom fields.
* **Richer error responses** — v2 returns structured error codes alongside error messages, making it easier to handle errors programmatically

## Known Parity Gaps in API v2

API v2 covers the vast majority of what v1 offers, but there are a few gaps worth knowing about. Some are permanent design decisions, others are temporary. Here's a clear breakdown so you can plan accordingly.

### Removed endpoints with no plans to return

Two v1 endpoint groups have been removed from v2 and won't be coming back:

* **Note followers** — the ability to [add](/v1.0.0/reference/bulkaddnotefollowers) or [remove](/v1.0.0/reference/removenotefollower) followers from a note via the API is no longer available
* **Feedback forms** — [listing configurations](/v1.0.0/reference/listfeedbackformconfigurations-1), [retrieving configurations](/v1.0.0/reference/getfeedbackformconfiguration-1), and [submitting a feedback form](/v1.0.0/reference/submitfeedbackform-1) are no longer supported

If your integration relies on either of these, you'll need to remove that functionality or handle it outside the API.

### Removed endpoints planned for a future release

A few v1 capabilities aren't available in v2 at launch, but they're on the roadmap. We're sharing these gaps upfront so you can plan your migration with full visibility — no surprises.

#### Custom field management

[Creating](/v1.0.0/reference/createcompanyfield-1), [updating](/v1.0.0/reference/updatecompanyfield-1), and [deleting](/v1.0.0/reference/deletecompanyfield-1) company fields via the API is temporarily unavailable in v2. You can still read and write values to existing custom fields through the [entity endpoints](/v2.0.0/reference/listentities) — it's only the field definition management that's missing.

#### Notes search limitations

v2 includes a [list notes](/v2.0.0/reference/listnotes) and [notes search](/v2.0.0/reference/performnotessearch) endpoint, but with more limited capabilities than v1. Specifically, v2 does not yet support:

* Full-text search across note content (the `term` parameter in v1)
* Filtering by tag (`anyTag` / `allTags` in v1)

#### What to do in the meantime

If your integration depends on any of these capabilities, you have two options:

* **Continue using v1** for the affected operations while migrating everything else to v2. Both API versions can run side by side, so you don't need to wait for full parity before starting your migration.
* **Watch for updates** — we'll announce new v2 capabilities through our [changelog](/v2.0.0/changelog) as they become available.

### Data consistency gaps

Some data has not yet been fully migrated between v1 and v2. The fields exist in v2, but the values may not match what v1 returns. These gaps are temporary — we plan to align the data in future releases.

#### Company source metadata

In v1, the [companies endpoint](/v1.0.0/reference/getcompany) returns source identifiers (`sourceOrigin` and `sourceRecordId`) used for CRM matching or deduplication. In v2, the equivalent concept is the `metadata.source` field on the company entity — but the data hasn't been fully migrated yet. v1 responses return `sourceOrigin` / `sourceRecordId` as expected, while v2 returns empty or null values in `metadata.source`.

If your integration relies on `sourceOrigin` and `sourceRecordId`:

* **Continue using v1** for company source identifiers — treat v1 as the source of truth until the data is aligned
* **Watch for updates** — we'll announce the fix through our [changelog](/v2.0.0/changelog) when `metadata.source` is fully populated in v2

### Notes response changes

The v2 [List notes](/v2.0.0/reference/listnotes) and [Get note](/v2.0.0/reference/getnote) endpoints return a leaner response than their v1 equivalents. The following fields are no longer included:

* `followers[]` — follower data is no longer part of the note response
* `comments[]` — comments are no longer embedded in note responses
* `totalResults` — no longer returned in list responses
* `features[].importance` — the importance value on note-to-entity relationships has been removed

If your integration reads any of these fields, you'll need to update your code to handle their absence. Call the v2 [List configurations](/v2.0.0/reference/listnoteconfigurations) endpoint for the current response schema.

## Important Considerations When Migrating to API v2

Beyond the parity gaps covered above, there are a few behavioral changes in v2 that could affect your integration in unexpected ways if you're not prepared. These aren't missing features — they're differences in how v2 handles operations you may already be using. Here's what to watch for.

### Cascading deletes

In v1, deleting a parent entity that had children was blocked — you'd get an error and have to delete the children first. In v2, those deletes cascade automatically:

| Entity                           | v1 behavior                             | v2 behavior                                          |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Feature with subfeatures         | Blocked — must delete subfeatures first | Cascading delete — subfeatures removed automatically |
| Release group with releases      | Blocked — error returned                | Cascading delete — releases removed automatically    |
| Release with feature assignments | Blocked — must remove assignments first | Release deleted, features remain unaffected          |

This applies to the [Delete a feature](/v1.0.0/reference/deletefeature), [Delete a release group](/v1.0.0/reference/deletereleasegroup), and [Delete a release](/v1.0.0/reference/deleterelease) v1 endpoints.

**Why this matters:** If your integration relied on v1's safeguard behavior — for example, treating a blocked delete as a signal that children exist — that safety net is gone in v2. An accidental delete of a parent entity will now remove all its children without warning.

**Workaround:** Add a pre-deletion check to your integration. Before issuing a DELETE, call the relevant list endpoint to verify whether the entity has children, and prompt for confirmation or block the operation in your own application logic.

### User and company creation for notes

In v1, the [Create a note](/v1.0.0/reference/create_note) endpoint accepted user and company identifiers like `user.email` or `company.domain` and would automatically create those records if they didn't already exist in Productboard. In v2, that auto-creation behavior is gone — users and companies must exist before you can assign a note to them.

#### How it works now

The v2 [Create a note](/v2.0.0/reference/createnote) endpoint accepts a user's email address directly in the `relationships` array:

```json
{
  "relationships": [
    {
      "type": "customer",
      "target": {
        "type": "user",
        "email": "user@example.com"
      }
    }
  ]
}
```

If the user exists, the note is created and assigned to them. If the user doesn't exist, the API returns a **404 error** — regardless of whether the associated company exists.

#### What to change in your integration

If your v1 integration relied on auto-creation, you'll need to handle the 404 case explicitly:

1. Attempt to [create the note](/v2.0.0/reference/createnote) with the user's email in `data.relationships[].target.email`
2. If you get a 404, [create the user](/v2.0.0/reference/createentity) via the entity endpoint (set `type` to `user`). If the user's company doesn't exist yet, it will be created automatically as part of user creation
3. Retry the note creation

This adds a conditional extra step to the note creation flow, but the happy path — where the user already exists — remains a single call.

### Create and update responses are minimal

In v1, create and update operations return the complete entity with all its fields — making it easy to update local state or display the result immediately. In v2, these operations return only a minimal reference:

```json
{
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "feature",
    "links": {
      "self": "https://api.productboard.com/v2/entities/123e4567..."
    }
  }
}
```

**Why this matters:** If your integration reads fields from the response body after a create or update — for example, to populate a UI or trigger downstream logic — those fields won't be there anymore.

**Workaround:** Follow up with a GET request to the URL in `links.self` to retrieve the full entity. If you're doing batch operations, consider whether you can defer the full retrieval until it's actually needed, rather than fetching after every write.

### Progress reporting in key result entities

The `progress` field on `keyResult` entities has changed in v2. In v1, the response included a server-computed `progress` percentage alongside the raw values:

```json
"progress": {
  "startValue": 1,
  "targetValue": 4,
  "currentValue": 2,
  "progress": 33.33
}
```

In v2, the computed percentage is removed. You get only the raw values:

```json
"progress": {
  "startValue": 1,
  "targetValue": 4,
  "currentValue": 2
}
```

See [Progress Fields types](/v2.0.0/reference/field-value-types#progress-fields) for the full schema.

**If your integration displays or uses that percentage**, you'll need to compute it client-side:

```python
progress = (currentValue - startValue) / (targetValue - startValue) * 100
```

Be sure to handle the edge case where `targetValue` equals `startValue` to avoid a division-by-zero error.

### Pagination

v2 uses the same [cursor-based approach](/v2.0.0/reference/pagination) as v1. There is no way to control the limit of the number of items returned in a page. This means that while you can still paginate through results, you won't be able to specify how many items you get back in each response. The best way to paginate is to keep fetching pages until you reach the end of the list, which is indicated by a `null` value of a `links.next` field in the response.

## AI Coding Agent Considerations

If you're using AI-assisted tools like Claude Code, Cursor, or GitHub Copilot to build or maintain your Productboard integration, there's one simple step you can take to get significantly better results: point your agent at the raw markdown version of the documentation.

### Fetch documentation as markdown

Productboard's API reference is available in markdown format by appending `.md` to any documentation URL. For example:

* Standard URL: `https://developer.productboard.com/reference/createnote`
* Markdown URL: `https://developer.productboard.com/reference/createnote.md`

### Why this matters for AI agents

When an AI coding agent fetches a standard documentation page, it has to parse through rendered HTML — navigation elements, scripts, styling — to find the actual API content. The markdown version strips all of that away, giving the agent clean, structured text that's easier to process.

This means:

* **More accurate code generation** — the agent can extract endpoint details, field names, and request/response schemas without noise
* **Up-to-date content** — fetching directly from the documentation source ensures the agent isn't relying on stale training data
* **Better migration guidance** — when moving from v1 to v2, an agent with access to both sets of markdown docs can map changes more reliably

If your agent supports tool use or web fetching, configure it to retrieve the `.md` variant of any Productboard API reference page before generating or updating integration code.

This advice applies to this document too so this document can also help steer your agent's understanding of the migration process and key considerations.

## Feedback and Help

We'd love to hear how your migration is going. If you have questions, run into issues, or want to share feedback on API v2, visit our [Feedback and Help](/v2.0.0/reference/feedback-help) page for support options and ways to get in touch with the team.