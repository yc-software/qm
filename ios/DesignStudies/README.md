# QM design studies

Five independent native SwiftUI interpretations of QM: Revolut, Waymo, Grok, Codex / ChatGPT, and Flighty. Each study has its own navigation, conversation presentation, composer, and agent activity treatment. Open the gallery to switch between them.

These are interactive visual prototypes with invented sample tasks and simulated replies. They do not connect to a QM workspace, execute agents, send messages externally, record audio, or persist conversations. The existing QM app is unchanged. No server configuration, API payload, or database schema changes are involved.

Brand reference observations and source links are in `References/`. Public interfaces are the basis for these interpretations; unpublished internal style guides and proprietary fonts are not included. QM is the product identity, and the referenced companies are not affiliated with these concepts.

## Run

From this directory:

```sh
xcodegen generate
open QMDesignStudies.xcodeproj
```

Select the `QMDesignStudies` scheme and an iPhone simulator. This standalone target uses bundle identifier `org.qm.designstudies`, supports iOS 18+, has no external dependencies, and requires no credentials or local configuration.

For quick review, launch with `-study revolut`, `-study waymo`, `-study grok`, `-study openai`, or `-study flighty`. Without this optional launch argument, the app opens the gallery. The control labeled “All designs” returns to the gallery.

Screenshots and build output belong outside the checkout. The generated Xcode project is ignored.
