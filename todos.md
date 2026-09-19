[x]: typing '/' in the convo editor should show available skills with proper 
     autocomplete semantics.
[ ]: DEFERRED: create a system where we can have default skills for the vn agent  that 
     are bundled with the app.  these are readonly, but the users are given 
	 the option to copy the skill into their project repo.  skill with the 
	 same name in the project override the default skills.	 
[ ]: DEFERRED: have a tour keep a record of what the author actually did while it ran
     — which step they were on, what they ran instead, where it diverged — and let them
     ask the agent about it ('what did I do wrong'). the agent reads the record and
     writes a new tour from it. only produced when the author asks for it.
[ ]: when the desktop app refreshes it doesn't layout to the current window size
[ ]: in the project editor the text/vision model ids should be configurable
[ ]: the text model selector should query gemini for latest models (if a gemini key exists)
     and should also include openrouter models.
[ ]: create report on our options to support deleting assets/scenes/locations/wiki-pages/etc.
     a plan will be created from this report later after I've reviewed it.
[ ]: use an agent to write a feature requirements report for a new git editor pane.  
     consult the frontend design skill to help you design the overall workflows, think
	 about what users will need here.
[ ]: the unsaved work on exit dialog should highlight an editor with the unsaved work
[ ]: create a 'save all' command in the main menu
[ ]: the task pane should show what a given task is currently doing (e.g. 'retry 1 of x') 
     there seems to be plenty of room in task boxes for a status line.
[ ]: think about what other ux from the assets editor we should replicate in the page editor
[ ]: clicking stop twice on the pipeline should pop up a dialog asking if you want to abort 
     the active tasks, if used affirms active tasks are aborted.
[ ]: write a report on formalizing our emergent design that assets form a linear history inside
     'slots'.  there's a lot of confusion right now, e.g. the approval popup lists stale assets.
[ ]: clamp the image aspect ratio per model.  openrouter's openai/gpt-5-image and
     gpt-5-image-mini reject aspect_ratio "16:9" (accepted: 1:1, 3:2, 2:3, auto), so
     every portrait planned with them fails with a 400 (18 orphaned tasks in dadsStory's
     tasks.jsonl from 2026-09-17).  snap the project's aspect to the nearest one the
     model accepts, or refuse up front naming the accepted list, rather than failing
     per task.
[ ]: in the convo editor, the edit and write tools should show a diff of changes, truncated at 
     100 lines.
[ ]: the report difficult agent editor should have somewhere for users to input feedback prior 
     to running the agent for the first time.
[ ]: Add a way to selete lines in the script editor, consult the frontend design skill
[ ]: When asked to create shots the agent should ask the user if they want manga multiframe shots
     or single frame ones.
[ ]: right clicking on story document subtree item should have a 'sort in topological order'
     option
[ ]: make sure all model picking menus are sorted alphabetically
[ ]: enable auto search menu mode for model picking menus (there's a setting in dropbox for that).
[ ]: add a ... menu in page header that includes an item to open the page's associated asset in 
     the asset editor.
[ ]: Add an option in the play pane header to show all dialog bubbles at once.
[ ]: reserve space in the page editor's notification box (that's below the header) for 
     3 lines of text, the goal is to prevent most layout jank.  it's still acceptable for longer 
	 notifications (e.g. errors) to expand the box.
