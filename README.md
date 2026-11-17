# CapitalOne Shopping Loader

Loads the offers from the CapitalOne Shopping home feed (`https://capitaloneshopping.com/`) and lets you search, filter and sort them.

## Filters
Reward, Offer type, Merchant and the category chips all accept several selections at once. Choices within one filter are OR'd (Price Drops or Popular Deals), different filters are AND'd.

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Select **Load unpacked** and choose this folder.
3. Open https://capitaloneshopping.com/ while signed in. An **Offers explorer** button appears at the bottom right.

## How it works
- Sends the same `POST /api/v1/feed` request the site sends, following `pagination.nextPageToken` for up to **Max pages** (default 20 pages, 25 offers each).
- **Activate Offer** opens each offer's own `href` (the site's `/api/v3/r?d=…` tracked redirect). The extension never builds or edits links.
- Results are cached for 20 minutes (the links are signed by the site, so stale ones may stop working).
- Only shown on the home page (`/`).
