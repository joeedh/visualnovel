

<!-- toc -->

- [Authoring](#authoring)
  * [Approval Pipeline](#approval-pipeline)
  * [Example workflow](#example-workflow)
  * [Scene Ordering](#scene-ordering)
- [AI agent](#ai-agent)
- [UX](#ux)

<!-- tocstop -->

This app is a full production system for building visual novels with generative AI. The app also has
applications for manga production and storyboarding.

Projects are stored in git repos.

The app has an integrated AI agent.

## Authoring

The authoring system has three components: the script, the story bible, and assets (such as character
descriptions, model sheets, and location prompts). The story bible is an arbitrary collection of
Markdown files that is provided to the AI agent as context, through vector embedding databases,
grepping, or some other retrieval mechanism. The bible is never pasted directly into the context window.
The story bible may optionally live in its own git repo, separate from the project repo. Two types of
story bible file are special: character files and set location files. A meta tag identifies them.

The script is a more structured collection of scenes. Each scene breaks down into lines, and those lines
are collected into shots. Each scene also has locations and characters.

Assets are separated into base assets and project assets. Base assets (such as character descriptions
and prompts, character model sheets, and locations) sit in their own folder subtree and may optionally
sit in their own git repo. Project assets are associated with specific scenes or shots, and one project
asset may be associated with several. Character outfits are optionally specified at the scene or shot
level.

### Approval Pipeline
Assets are generated via generative AI. Assets are approved by the user. The first assets to be
generated are the base ones, e.g. characters, set location references. Generated assets are checked for
correctness by the AI agent before being presented to the user for final approval.

### Example workflow

The user starts with an empty project. The app prompts the user to pick a directory for the project. The
app initializes a git repository if necessary. The app commits any existing files automatically.

The user edits the story bible through the UX. The story bible always lives under `wiki/`, because
"wiki" is more familiar to users than the term "story bible". When the user creates a new character, the
app initializes it from a template. A sidebar holds a logical document tree. The tree will have a mode
that lists every file, but by default the local document tree shows the story bible file tree, the
assets, and the script tree. The script tree divides into scenes, and each scene divides into shots;
shots are not broken into separate files yet. The sidebar also holds a tree for characters. Clicking a
character opens a panel with links to that character's story bible file, its base assets, and the scenes
and shots it appears in.

The user edits the character's markdown in the app and saves it, then creates a story notes markdown
file and saves that. Saving a file also commits it to git. The user returns to the character file and
clicks a button to generate character assets. The user reviews the model sheets that generative AI
created and provides feedback on them.

The user repeats this for several more characters, then writes a story outline or treatment. At this
point the user may manually invoke a context update, which regenerates the index files (or tree of index
files), `agents.md`, or whatever else the AI agent uses. Context updates will eventually run
automatically.

### Scene Ordering
Shots can be reordered within a scene. Scenes can also be ordered in a tree (this is a visual novel),
and a scene is reordered within that tree by editing the decisions and the scenes they lead to.

## AI agent
The AI agent should be able to help the user operate the app, and it should open the UX that edits or
views any part of the story project.

## UX

The UX will be a 2D dockable layout that subdivides into 'editors'. Each editor can optionally have a
header (which may have menus or icons), a footer, and sidebar panels.
