# Overview

Productboard REST API v2 is the next-generation API designed to be more consistent, flexible, and developer-friendly than API v1.

## What is API v2?

Productboard REST API v2 is the next-generation API designed to offer a cleaner, more consistent, and more scalable developer experience compared to API v1. It reflects how the Productboard data model has evolved and unlocks new possibilities for automation and integrations.

API v2 introduces a new concept: [configuration endpoints](/v2.0.0/reference/configuration-endpoint) that describe the shape of data in your workspace. These allow your integration to discover field definitions dynamically, making it easier to build flexible, future-proof integrations.

***

## What APIs are offered?

Currently we offer 8 groups of API:

* Notes API
* Entities API
* Teams API
* Members API
* Jira Integrations API
* Plugin Integrations API
* Webhooks API
* Analytics API

You can view the <Anchor label="2.0.0 OpenAPI specifications here." target="_blank" href="https://developer.productboard.com/v2/openapi">2.0.0 OpenAPI specifications here.</Anchor>

### Notes API

The `note` entity in Productboard represents customer feedback, ideas, conversations, and user insights collected across your product discovery process.

Productboard’s API v2 supports the following **note types**:

* `textNote` – standard note containing freeform feedback or internal insights
* `conversationNote` – multi-part threaded content (e.g. a chat between a user and support agent)
* `opportunityNote` – structured feedback linked to opportunities (currently read-only via API)

Notes can include:

* Text content
* Tags
* Owners
* Customer relationships (user or company)
* Relationships to product hierarchy entities (e.g. features, components)

To inspect which fields are available for notes in your workspace, use the [Get note configuration](/v2.0.0/reference/getnoteconfiguration) endpoint.

For more about how notes are used in Productboard, see:

* [Quick start guide: Feedback](https://support.productboard.com/hc/en-us/articles/26907498937235-Quick-start-guide-Feedback)
* [Link user feedback to related feature ideas using insights](https://support.productboard.com/hc/en-us/articles/360056354514-Link-user-feedback-to-related-feature-ideas-using-insights)
* [Use insights boards to group related notes](https://support.productboard.com/hc/en-us/articles/360056354634-Use-insights-boards-to-group-related-notes)

### Entities API

Productboard REST API 2.0 supports a flexible and extensible data model. The following **core entity types** are available through the `/entities` endpoints:

* `product`
* `component`
* `feature`
* `subfeature`
* `initiative`
* `objective`
* `keyResult`
* `release`
* `releaseGroup`
* `user`
* `company`

To learn how these entities are structured in your workspace and which fields are available, start with the [Get entity configuration](/v2.0.0/reference/getentityconfiguration) or [List entities](/v2.0.0/reference/listentities) endpoints.

For a deeper understanding of how these concepts map to the Productboard user interface, check out:

* [Fundamentals of Productboard - Product Hierarchy](https://support.productboard.com/hc/en-us/articles/27858826222355-Fundamentals-of-Productboard#h_01HR7PQBAJ7SN8VTQ3KVBQ33EB)
* [Initiative management in Productboard](https://support.productboard.com/hc/en-us/articles/25194993652627-Initiative-management-in-Productboard)
* [Defining your product objectives](https://support.productboard.com/hc/en-us/articles/360058181234-Defining-your-product-objectives)
* [Building and tracking key results](https://support.productboard.com/hc/en-us/articles/29223362626067-Building-and-tracking-key-results)
* [Plan releases to decide what to deliver when](https://support.productboard.com/hc/en-us/articles/360058214113-Plan-releases-to-decide-what-to-deliver-when)
* [Customer data management](https://support.productboard.com/hc/en-us/sections/38284490018579-Customer-data-management)

### Teams API

The Teams API allows you to programmatically manage teams in your Productboard workspace. You can create and update teams, retrieve team details, and manage team membership by adding or removing members.

More information about teams in Productboard can be found in the [Organize members into teams](https://support.productboard.com/hc/en-us/articles/360058174393-Organize-members-into-teams) guide.

### Members API

The Members API gives you access to member data within your workspace. You can list all members, retrieve details for a specific member, and see which teams a member belongs to.

### Jira Integrations API

The Jira Integrations API allows you to read the Jira integrations configured in your workspace and inspect their connections to Productboard entities. This is useful for building workflows that bridge your Productboard and Jira data.

### Plugin Integrations API

The Plugin Integrations API allows you to create and manage plugin integrations and control their connection states. Use this to build custom integrations that appear and operate inside the Productboard UI.

### Webhooks API

The Webhooks API allows you to subscribe to events in Productboard and receive real-time notifications when data changes. This is useful for keeping external systems in sync without polling.

### Analytics API

The Analytics API provides access to usage data that helps you understand how Productboard is being adopted and used across your workspace.

You can retrieve metrics related to:

* Feature views
* User activity and engagement
* Note processing trends
* Insights usage
* Board views and interactions

These metrics can be used to:

* Build internal dashboards
* Monitor adoption across teams
* Identify underused areas of the product
* Measure the impact of product initiatives

Analytics data is read-only and typically used for reporting and analysis purposes.
All data is scoped to your workspace and requires appropriate permissions.

To get started, see:

* [List member activities](/v2.0.0/reference/listmemberactivities)

***

## Configuration endpoints

Productboard workspaces can be customized with different fields, workflows, and structures — which means the data model isn't static.

To support this flexibility, API v2 introduces **`/configurations` endpoints** for each resource type. These endpoints return:

* A list of available fields for the resource
* A list of available filters for the resource
* Metadata about each field (type, label, options, etc.)
* How those fields can be used when creating or updating records

Instead of relying on hardcoded assumptions, you can query the `/configurations` endpoint to understand the current shape of the data — tailored to each workspace.

Example:

```curl
GET /notes/configurations
```

This makes your integration more resilient and adaptable as Productboard evolves. Learn more in the [Using Configuration Endpoints guide](/v2.0.0/reference/configuration-endpoint).

***

## Design principles

This API is built around a few core principles:

* **Consistency** – predictable naming, uniform structure, clear resource models, consistent naming
* **Flexibility** – support for dynamic schemas and workspace-specific configuration
* **RESTful design** – standard HTTP methods, resource-oriented URLs, JSON payloads
* **Developer experience** – intuitive structure, helpful errors, easy to get started

This version builds on everything we learned from API v1, and is designed to support how Productboard is used in complex, real-world workflows.

***

## Authentication

Authentication is required for all requests. We support:

* API Token (PAT)
* OAuth 2.0 Authorization Code
* OAuth 2.0 JWT Bearer

See [Authentication](authentication) for details.

***

## Rate Limits

Rate limits apply to all requests.

* 50 requests per second per access token
* If you exceed this, you'll receive an HTTP 429 response with a `Retry-After` header

See [Rate Limits](rate-limits) for more information.

***

## Known issues and limitations

You can find up-to-date known issues and missing functionality in the [Known Issues](known-issues) section.