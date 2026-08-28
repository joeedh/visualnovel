[ ]: pressing ctrl +/- should increase/decrease text size 
     (presumably via whatever api electron exposes to alter devicePixelRatio?).
[ ]: review the text in the run pipeline dialog.
[ ]: make sure the debug agent editor has text warning the user about 
     token cost.
[ ]: typing '/' in the convo editor should show available skills with proper 
     autocomplete semantics
[ ]: DEFERRED: create a system where we can have default skills for the vn agent  that 
     are bundled with the app.  these are readonly, but the users are given 
	 the option to copy the skill into their project repo.  skill with the 
	 same name in the project override the default skills.
[ ]: make sure the debug agent can access the bundled source tree in installed
     builds
[ ]: you should be able to click 'accept' on old versions of assets, in which case the 
     existing asset and its prompts will become stale and the old one (including its
	 prompt chunks) will be set at the latest one in the slot.
[ ]: the asset editor should have a download button for the rendered image
[ ]: the gen graph editor should show the name of the asset referencing the shot
[ ]: gen graph editor should have a 'regenerate' button that runs the pipeline
[ ]: when showing things in editors (e.g. double clicking shots in shot coverage 
     editor to show the shot in the asset editor) the largest available non-document-tree-holding
	 area should be used according to the normal editor swapping rules, which are documented 
	 somewhere. currently double clicking a shot swaps it with the document tree editor.
	 make a node in CLAUDE.md to avoid this mistake in the future.
[ ]: you should be able to edit the characters list in the shot coverage editor's 
     'in this shot' section.
[ ]: you should also be able to disable the enforcement of characters appearing in 
     the shot altogether.
[ ]: make it so you can select the shot variant in the shot coverage editor too.
[ ]: if the active asset in the asset editor is blocked a red question mark icon 
     should display next to the task button in the header, with a tooltip explaining
	 to click on the task button to see what's blocking the task.
[ ]: clicking the notification button can take a while to pop up notifications, 
     add support for paging so we're not instantiating all of them at once into 
	 the DOM.
	 