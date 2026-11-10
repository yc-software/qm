# Revolut reference study

Research date: 9 November 2026. QM remains the product name; Revolut is the visual reference. This study is a local interaction prototype with invented work examples, not a connected QM client or a Revolut product.

## Sources inspected

- [Revolut: The era of ease has arrived with Revolut 10](https://www.revolut.com/blog/post/revolut-10/) — official account-navigation and theme redesign announcement.
- [Official account-navigation visual](https://assets.revolut.com/published-assets-v3/f30ae5b4-de48-4d5f-b338-40a69a9f894a/1a534921-8e7e-42e8-b092-0409ea752d41.png) — inspected visually in a browser. Shows black metallic, violet and blue home treatments, centered balances, and compact account-selection pills.
- [Revolut Japan: Revolut 10 introduction](https://www.revolut.com/en-JP/blog/post/rev10-introduction/) — official annotated home-screen walkthrough.
- [Official annotated home-screen visual](https://assets.revolut.com/published-assets-v3/f94d7b75-7692-49f5-a8dc-5b74ffb409e9/97149991-6598-4a5b-979e-4f28c53ce68c.png) — inspected visually in a browser. Shows avatar/search/action header, centered main figure, four circular actions, compact widget cards, transactional activity rows and bottom tabs.
- [Official rollout description](https://www.revolut.com/news/revolut_launches_revolut_10_as_it_targets_primary_accounts_and_passes_35m_customers_worldwide/) — confirms clearer account switching and configurable homepage widgets, themes and backgrounds.

## Observed

The hierarchy is unusually centered: a very large bold figure sits above a compact account pill. Search and small circular actions occupy the top row. Primary actions are circular icons with short labels below them. Content becomes dense underneath the hero through rounded widget cards and activity rows with circular leading icons. Dark themes use near-black foundations, translucent neutral controls, white primary text, restrained secondary text and colorful accents. The official black theme includes broad diagonal metallic folds. The page describes theme customization, so a single universal app background is not implied.

## Adapted to QM

QM keeps its chat information architecture: Chats, search, All/Working/Needs you filters, recent conversation previews, New chat, a model chooser, and the existing conversation screen. Revolut contributes bold sans typography, a near-black/white palette, cobalt actions, rounded surfaces, circular icon controls, and its spacing hierarchy. Banking balances, account navigation, numeric dashboards, widgets, and finance-specific structure are not carried over. Search, filters, chat navigation, model switching, local approval and sample message sending work inside the prototype.

## Inferred and approximate

Exact proprietary typeface, point sizes, spacing values, radii and color tokens were not published in the inspected pages. The implementation uses system sans typography, a cobalt accent, 20–24 point card corners and 44-point minimum controls as visual approximations. QM conversation content, agent presentation and chat styling are adaptations, since these sources show the financial home rather than a QM-like chat. The official app screenshots are from the Revolut 10 launch; they establish the observed design lineage, not proof of the latest authenticated app build.

## Aside research

The installed `aside-browser` skill and `aside guide` were read. A dedicated read-only Aside research agent was launched with `aside exec --json --timeout 5m` and the official pages above, asking it to inspect screenshots and distinguish observed details from inference. Aside session: `ewwQz53ChxAZJxB3` (“Revolut iOS design research for QM chat”). The session completed and independently confirmed the central balance hierarchy, circular actions, pill selectors, soft rounded panels, compact bottom navigation, and customizable dark artwork. It explicitly identified the inspected Rev10 screenshots as October 2023 marketing assets, not a live capture of the latest iOS app.

No backend configuration, persisted schemas or API payload shapes were changed. All prototype state is disposable sample UI state.
