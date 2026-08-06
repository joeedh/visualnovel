

<!-- toc -->

- [Authoring](#authoring)
  * [Approval Pipeline](#approval-pipeline)
  * [Example workflow](#example-workflow)
  * [Scene Ordering](#scene-ordering)
- [AI agent](#ai-agent)
- [UX](#ux)

<!-- tocstop -->

This app is a full production system for visual novel production via 
generative AI.
Note that this also has applications for manga production and 
storyboarding.

Projects live in git repos.

The app has an integrated AI agent.

## Authoring

The authoring system has three components: the script, the story bible, and assets 
(such as character descriptions and model sheets, location promps, etc).
The story bible is an arbitrary collection of markdark files that is provided
to the AI agent as context (this can be done through vector embedding databases
or grepping or whatever, the bible is *not* directly pasted into the context window). 
Note: the story bible may optionally be in its own git repo separate from the 
project repo.  Note that there are two special types of story bible files: character 
files and set location files.  These are identified via some kind of meta tag.

The script is a more structured collection of scenes.  Scenes are broken down 
into lines which are collected into shots.  Scenes have locations and characters.

Assets are separated into base assets (such as character descriptions and prompts, 
character model sheets, locations, etc) that are in their own folder subtree and may
optionaly be in their own git repo, and project assets that are associated with specific
(possibly multiple) scenes or shots.  Character outfits are optionally specificed at the 
scene or shot levels.

### Approval Pipeline
Assets are generated via generative AI.  Assets are approved by the user.  
The first assets to be generated are the base ones, e.g. characters, set location 
references.  Generated assets are checked for correctness by the ai agent before 
being presented to the user for final approval.

### Example workflow

The user starts with an empty project.  The app requests the user to pick a directory for the 
project.  The app initializes a git repository if necassary.  It will automatically commit 
existing files.  

The user uses the UX to edit the story bible.  The story bible is always under wiki/ ('wiki' is
more familiar to users then the concept of a story bible).  The user creates a new character,
the app initializes it with a template. There is a sidebar with a logical document tree;
it will have a mode for a full file tree to view every file, but the default local document
tree shows the story bible file tree, assets, and the script tree (which remember is broken 
down into scenes which further divide into shots, note that shots are not broken
into separate files at least not yet).  In addition there is a tree for characters, clicking
on it shows a panel with links to the character's story bible file, base assets, and which
scenes and shots it appears in.

Anyway the user can edit the markdown of the character in the 
app.  The user saves it, then creates a story notes markdown file and saves that.  Saving files 
also commits to git.  The user goes back to the character file and clicks a button to generate 
character assets.  The user reviews and provide feedback for the model sheets created by generative 
AI.

The user repeats this for several more characters, and writes a story outline or treatment.
At this point the user may manually invoke a context update that will regenerate whatever 
index files (or tree of index files) or agents.md or whatever the ai agent uses.  note that 
we will eventually make context update automatic. 

### Scene Ordering
Shots can be reordered inside of scenes.  Scenes can also be ordered in a tree 
(since this is a visual novel) and scenes can be reordered inside this tree by editing
the decisions (and the scenes they lead to).

## AI agent
The AI agent should be able to help the user drive the app, showing the UX to edit or view any part of 
the story project.

## UX

The UX will be a 2d subdividing dockable UX that subdivides into 'editors'.  Each editor can optionally 
have a header (which may have menus or icons), a footer, and sidebar panels.
