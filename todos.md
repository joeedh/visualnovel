[x]: the asset editor should have a 'seed' field 
[x]: the 'close pane' view menu should invoke the interactive pane closing pathux
     tool where the user selects an editor to close with the mouse (the editor is highlighted
	 with a border and maybe big red X) then clicks to close it.  if it doesn't exist write it.
[x]: The recent projects menu is empty, fix it.
[x]: popup dialogs should have a more visually distinctive border 
     and reasonable width limit (currently some popups can take up the whole screen).
[x]: the add model key dialog should have a dropdown to select anthropic vs google gemini
[x]: the agent should show a running total of tokens used to the user similar 
     to how claude code shorts total tokens.
[x]: when creating a character the default template should include the full character sheet
     with example values (outfit, traits, etc) except for palettes.  instead there should be 
	 a note explaining what palettes and how to make the agent create it.
[x]: the run pipeline command should popup a bigger and more substantial dialog.  it should have 
     an accurate count.  when the pipeline is running the run button should be disabled, also 
	 the main header should have a little rotating busy icon (you should be able to use a normal
	 iconsheet svg icon with a css animation) with a tooltip explaining the pipeline is running 
	 and how many tasks are left.
[x]: the document tree's arrays need to be 3x larger, they are too small.
[ ]: the pipeline should render character portraits even if the characters aren't used in a scene yet. 
     it should also do the same with locations.
[x]: On asking the model 'how do I write a dialog line so it's picked up by the pipeline' I got the error
     'I couldn't produce a valid action (no JSON found in model output)' fix it
[x]: When a user writes a new line of dialog themselves, the speaker defaults to narrator.  The text 
     (if there is any) is visually indistingushably from the background, thus the user has no idea 
	 how to set the speaker.  fix this.
[x]: the agent model text in the main header should have a tooltip 'current agent model - set in convo
     tab'.
[ ]: character model sheets should reference 
[x]: clicking 'regenerate' on an asset should automatically run the pipeline if the asset is 
     the only task.
[x]: the main menu should have a 'run pipeline' button.  it simply starts the pipeline (no popup).
     the existing run pipeline menu entry is unchanged, but should be renamed to 'run pipeline (adv)'.
[x]: remove the double confirmation where the user clicks 'run pipeline' then has to click 
     'confirm - run pipeline' again.
[x]: when running the pipeline there should be a red stop icon in the main header.
[x]: double clicking a location in the document tree should show it in a wiki editor (making 
     one active if necassary).  if a proper location sheet file doesn't exist then one should 
	 be created.
[x]: make sure all menu items in the app (including context menus) have tooltips.
[x]: give the model a multichoice user input tool where the user picks choices from 
     a list (along with 'type answer here' and 'chat about this').
[x]: the 'new scene' context menu item in the document tree doesn't work
[x]: a scene's location should be editable.  the user should be warned about the consequences
     and told they can use the agent to mitigate them.
[x]: the llm's list_workspace tool apparently doesn't update after a new location sheet is created.
[x]: the agent got a bit confused when creating a new scene, it failed to link the scene into the graph.  
     test it, see if you can reproduce this and fix it.  search the conversation history for the test3 repo.  
[x]: the name of the project should be shown in the app's title bar 
[x]: document tree failed to update after manually connecting two scenes in the branches editor.
[x]: document tree also failed to update when the agent created a scene.
[x]: the convo editor should have a 'stop' button to interrupt the agent, only shown when the agent is working.
[x]: the project name in the main header should have a rounded outline 
[x]: clicking run pipeline (in the main menu or the header button) should display a message 
     if it cannot run (e.g. the agent is running?).
[x]: when an asset becomes stale it should not be marked as 'accepted' in the document tree.
[ ]: can the document tree's asset subtree use asset slots instead of hashes to prune out old/rejected
     assets?
[x]: you should be able to right click a line and get a menu with 'open shot asset'.
[x]: the agent should be provided the active scene (if it's not already).

[ ]: the agent had an error again (in the git_commit tool), search the transcripts for project test4 at august 17th, 2026
[ ]: the document tree isn't always refreshed after the agent creates a wiki page
[ ]: the wiki editor should word wrap lines.
[ ]: the agent itself should generate files with a 100 column word wrap limit.  update the system prompt.
     if you think modifying the write_file tool to give a warning or an error on exceeding the limit is 
	 a good idea you may do that.
[ ]: the new wiki context menu item doesn't refresh the tree on creation
[ ]: the notifications popup needs a vertical scrollbar.  if there's a large number of items 
     they are simply drawn on top of each other in a tangled mess.
[ ]: make sure path.ux's help picker works.  it just shows tooltips under the active mouse.
     it's designed to help show tooltips when using multitouch input.
[ ]: modify the system prompt so when the user asks the agent to create things with a category,
     that category is mentioned in the associated wiki pages.  for example 'create 4 love interests'
	 will create 4 characters with 'love interest' in the character sheets.  the idea is to make 
	 it easier for the model to identify which characters are the love interests.
[ ]: in a similar vein to the above, the agent should list characters in plot important categories
     in whatever we ended up calling the root agent memory file that lives in the project repo.
[ ]: when the user create a wiki page via right click -> new wiki page, it should be made the active 
     wiki page.	 
[ ]: agent tools should show their arguments where it makes sense, e.g. read_file should show the 
     (relative to the project repo root) path of the file being read.
[ ]: The tokens counter label should keep track of uncached tokens only.
[ ]: 
     