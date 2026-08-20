[ ]: Clicking an asset in a popped up tasks window should be able to set the active asset to it and open it 
     in an asset editor.
[ ]: changing the token budget doesn't update its dropdown menu until the agent runs.
[ ]: pathux's help picker should not close a tooltip on pointer up if triggered by multitouch.
     it should instead register a global pointer down handler to close it (don't 
	 block the pointer down going to its other consumers).  there should be a backup timer 
	 to close the tooltip after 30 seconds.  in the multitouch case the user's own finger 
	 can block the tooltip.
[ ]: clicking a project in the recent projects menu doesn't open it
[ ]: notifications still sometimes show text lines on top of each other in a tangled mess
[ ]: notifications popup show open below the notifications icon when clicking it,
     right now it shows up a few hundred pixels away.
[ ]: when clicking a task in the tasks editor that's done and has an assoicated asset it should open 
     the asset in the asset editor.
[ ]: tasks editor should have a 'only running' checkbox.  also split it's header into two rows.
[ ]: After tellig the agent to approve all artwork with approve_assets tool there are still assets in teh 'Awaiting approval' document subtree
[ ]: task graph editor needs a button to relayout the graph to a prettier and more readable layout
     (the graph is not modifed, it's just displayed in a better layout; you may use d3 for this if 
	  you want).
[ ]: split the convo editor's header into two rows
[ ]: create a new editor to view the agent's final system prompt. this should be a hidden editor 
     created via a / command palette command.
[ ]: create a 'recursively approve and generate assets' command that recursively approves all 
     rendered assets, runs the pipeline, and repeats until all assets have generated. put it 
	 in a new 'edit' menu that sits between view and help.