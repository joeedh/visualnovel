[x]: swap the 'edit' and 'view' menus in the menubar 
[ ]: see if you can style the scrollbars.
[ ]: pressing ctrl +/- should increase/decrease text size 
     (presumably via whatever api electron exposes to alter devicePixelRatio?).
[x]: right clicking a scene should have an 'edit in agent' that prefills 
     the agent message box with 'edit [scene id] '.
[ ]: review the text in the run pipeline dialog.
[ ]: make sure the debug agent editor has text warning the user about 
     token cost.
[ ]: typing '/' in the convo editor should show available skills with proper 
     autocomplete semantics
[x]: right clicking on assets/shots/locations/etc should have a 'copy [type] id'
     in the context menu that copies the id to the clipboard.
[ ]: create a system where we can have default skills for the vn agent  that 
     are bundled with the app.  these are readonly, but the users are given 
	 the option to copy the skill into their project repo.  skill with the 
	 same name in the project override the default skills.
[ ]: double clicking a shot in the shot coverage editor should make it 
     active in the asset editor.
[x]: change the command palette hotkey from / to ctrl-shift-p 
[x]: right-clicking context menu in the document tree (and ux in the asset editor) should
     check if an asset is approved and if so have a 'un-approve' item instead 
	 of 'approve'.  Make sure to update all the context menus in the document 
	 tree with an 'approve' item.
[x]: add an unapprove_assets tool to the vn agent miroring approve_assets.
[ ]: make sure the debug agent can access the bundled source tree in installed
     builds
[x]: clicking the model name in the main menu bar should let you select the model
[ ]: you should be able to click 'accept' on old versions of assets, in which case the 
     existing asset and its prompts will become stale and the old one (including its
	 prompt chunks) will be set at the latest one in the slot.
[ ]: the asset editor should have a download button for the rendered image
[x]: the node editor doesn't redraw itself after being resized by the user 
[x]: create a delete hotkey in the node editor for deleting nodes
[x]: the unapproved assets subtree in the document tree should not show stale assets
[x]: create a separate 'stale' subtree instead
[x]: clicking a shot in the document tree should make it active in the 
     gen graph editor if a graph is bound to it 
[x]: add a 'create shot graph' context menu entry when right clicking asset slots
[x]: make the gen graph editor match the rest of the app's dark theming.
[x]: the pending approval dropdown thingy in the main menu bar should not show stale 
     assets.
[x]: the GenTemplate node's a/b/c sockets should be renamed varA varB varC 
[x]: the document tree should have a gen graph subtree
[ ]: editing a node property in the gen graph editor is slow — planned in
     docs/plans/gengraph-editing-cost-tasklist.md
[x]: the gen graph editor should have a button to view its associated asset if it has one
	 in the asset editor
[x]: when editing text properties in the gen graph editor they should only commit 
     when the textbox loses focus or the user presses enter.	 
