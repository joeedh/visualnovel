

[x]: the agent had an error again (in the git_commit tool), search the transcripts for project test4 at august 17th, 2026
[x]: the document tree isn't always refreshed after the agent creates a wiki page
[x]: the wiki editor should word wrap lines.
[x]: the agent itself should generate files with a 100 column word wrap limit.  update the system prompt.
     if you think modifying the write_file tool to give a warning or an error on exceeding the limit is 
	 a good idea you may do that.
[x]: the new wiki context menu item doesn't refresh the tree on creation
[x]: the notifications popup needs a vertical scrollbar.  if there's a large number of items 
     they are simply drawn on top of each other in a tangled mess.
[ ]: make sure path.ux's help picker works.  it just shows tooltips under the active mouse.
     it's designed to help show tooltips when using multitouch input.
[x]: modify the system prompt so when the user asks the agent to create things with a category,
     that category is mentioned in the associated wiki pages.  for example 'create 4 love interests'
	 will create 4 characters with 'love interest' in the character sheets.  the idea is to make 
	 it easier for the model to identify which characters are the love interests.
[x]: in a similar vein to the above, the agent should list characters in plot important categories
     in whatever we ended up calling the root agent memory file that lives in the project repo.
[x]: when the user create a wiki page via right click -> new wiki page, it should be made the active 
     wiki page.	 
[x]: agent tools should show their arguments where it makes sense, e.g. read_file should show the 
     (relative to the project repo root) path of the file being read.
[x]: The tokens counter label should keep track of uncached tokens only.
[x]: the tasks editor should refresh itself automatically 
[x]: agent threads should remember which model and effort level they're on 
[x]: the multichoice user input tool for the agent should allow you navigate to previous/next 
     questions and have a final 'submit answers' button, similar to claude code's behaviour
[x]: the user should be informed about api errors and given the option to select another model provider,
     or automatically retry 10 times with whatever backoff semantics the model providers recommend.
	 if the choose to retry the main header should show the current retry number and a notification
	 should be issued on success or failure (make sure the retry count is cleared from the header
	 properly when it's done).
[x]: unapproved assets in the document tree should list assets in topological order, with 
     roots at the top so users can easily see what needs to be approved immediately.
[x]: unapproved assets should split between pure slot assets that need parent assets approved 
     before they can be created (pick a name for the subtree header) and existing assets that 
	 need review.
[x]: the convo editor lacks a create new thread button (didn't this used to exist?).
[x]: make sure clearing a conversation thread commits the existing thread first so 
     it remains in the project repo's git history.  also let's add thread metadata
	 to keep track of which git commits contains a thread's pre-cleared contents
	 so the debug agent can discover them.
[ ]: the agent should be able to approve assets.  create a specific tool for this, the tool 
     should use haiku to read the most recent user prompts from the thread transcript 
	 to ensure the user specifically asked for this.  the full list of valid approvable 
	 assets should then be fed to haiku which will then filter it according to the user's instructions
	 (e.g. 'approve all location assets', 'approx X character' etc).  the final approval list 
	 will be displayed to the user for approval prior to execution.
[x]: make sure the nature of how art style works (e.g. any style fields in the schema, the way prompt chunks work and 
     how they are inherited, etc) is explained to the agent in the system prompt.
[ ]: when the user invokes the pipeline and a tasks editor isn't open, a floating popup screen area with 
     a tasks editor should be created.  note that this may require adding support for floating popup screen 
	 areas to path.ux.  they should have a titlebar to move around, be resizable and have a close button.
	 there should be an api to interrupt closing to e.g. display unsaved work warnings or 
	 whatever (we won't need it but the capability should exist).  it should be a simple event 
	 handler.
[x]: the tasks editor never shows running tasks
[x]: if you click the warnings label (turn it into a button) on the main menu bar it should popup a 
     dialog box showing the warnings.
[x]: when the document tree truncates a subtree with '... and X more' you should be able to click 
     on it to show the truncated items.
[x]: pressure test the tasks editor to make sure all of its functionality works
[x]: asks editor: add a checkbox to 'show only completed tasks'.  also add a 'clear finished tasks'
     button.
[x]: the system used to make a specific type of editor visible should try to avoid screen areas with 
     active conversation editors.
[ ]: change path.ux so the little 'x' close buttons on area tabs is optional, if they're 
     disabled path.ux should automatically append 'right click->close to close' (pick 
	 the best wording) to the each editor tab's tooltip.
[ ]: disable the little 'x' close buttons on area tabs.
[ ]: use an agent to add support in path.ux for multiline tab bars.  the idea is that when there are 
     too many tabs to display in the available width/height (depending on whether we are horizontal or
     vertical) additional tab rows are created. this should be an optional 
     features of tab containers, used by the screen area tab bar.  the agent should branch both path.ux
	 and it's path-controller submodule, write a plan, pressure test the plan, and then implement it.
	 I'll review the result and merge it to path.ux's master later before we push anything to git.
[ ]: after the above item completes, also make it so if tab bars do not have multiline enabled 
     they will support scrolling horizontally via mousescroll events, right clicking and dragging,
	 or a two-finger multitouch gesture (the latter may have to abort an in-progress tab drag).
	 do not display a physical scrollbar.
[x]: the document tree should have a 'close all' icon button.  create an appropriate icon.
[ ]: write a plan to fully support anthropic, gemini, openai and grok models for the agent, and also 
     supporting more image model providers (e.g. openai, propose one more).
[ ]: write a research report on supporting local models, either physically on the same machine or a server the 
     user has on their home network.  the report should include local image models.
[x]: Make the assets subtree show assets by slot.  Clicking a slot opens its most recent asset in 
     the asset editor.  Clicking it again will expand a subtree of prior generated assets.  the 
	 tooltip should explain this, e.g. 'Show the asset in the asset editor; click again to see history'.
[x]: Do not explain in tooltips in the document editor how clicking an item displays it in every editor 
     of that type, just say it opens it in that editor.
[x]: Editors that operate on active things should have a blender-style pin icon to prevent them from changing
     to a different thing when it becomes active.  We should support serializing this in pinnable editor
	 STRUCT scripts.
[x]: Use an agent to write a report on a less technical mode in the desktop app that would automatically 
     approve assets. Think about any other simplifications.  This mode would be for people to play around with.