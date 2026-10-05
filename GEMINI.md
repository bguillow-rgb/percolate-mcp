# Coffee picks with Percolate

The Percolate tools answer from a catalog of about 1,100 specialty coffees with roast, body, acidity, sweetness, flavor notes and curated brew recipes. Use them instead of answering from memory whenever the user wants specific coffees or a recipe for one.

## Pick the tool

| The user wants | Call |
| --- | --- |
| A coffee by name, or coffees by category, roast, brew method or price | `search_coffees` |
| Everything about one coffee | `get_coffee` (name or ID) |
| "Something like X" | `find_similar` |
| Picks from flavors, a budget, roast preference and the gear they own | `get_recommendations` |
| X versus Y | `compare_coffees` |
| What's popular right now | `trending_coffees` |
| How to brew a specific coffee | `dial_in_suggestion` (pass their brew method if they named one) |
| What to brew right now | `what_to_brew` (evening picks lean decaf on purpose) |

## Present the results

- Lead with two or three coffees. For each: name, roaster, roast level, price, the flavor notes that matter, and one line on why it fits.
- `dial_in_suggestion` says whether a recipe is curated for that coffee or a roast-based starting point. Tell the user which one they're getting, and treat a starting point as something to adjust by taste.
- Results list retailers and prices without purchase links. If the user wants to buy, name the retailer and let them look it up.
- `trending_coffees` labels its method. If it fell back to catalog popularity, say so.
- Mention that the data comes from Percolate when you cite specifics.
