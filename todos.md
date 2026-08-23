[ ]: swap the 'edit' and 'view' menus in the menubar 
[ ]: see if you can style the scrollbars.
[ ]: pressing ctrl +/- should increase/decrease text size 
     (presumably via whatever api electron exposes to alter devicePixelRatio?).
[ ]: right clicking a scene should have an 'edit in agent' that prefills 
     the agent message box with 'edit [scene id] '.
[ ]: review the text in the run pipeline dialog.
[ ]: make sure the debug agent editor has text warning the user about 
     token cost.
[ ]: typing '/' in the convo editor should show available skills with proper 
     autocomplete semantics
[ ]: right clicking on assets/shots/locations/etc should have a 'copy [type] id'
     in the context menu that copies the id to the clipboard.
[ ]: create a system where we can have default skills for the vn agent  that 
     are bundled with the app.  these are readonly, but the users are given 
	 the option to copy the skill into their project repo.  skill with the 
	 same name in the project override the default skills.
[ ]: double clicking a shot in the shot coverage editor should make it 
     active in the asset editor.
[ ]: change the command palette hotkey from / to ctrl-shift-p 
[ ]: right-clicking context menu in the document tree (and ux in the asset editor) should
     check if an asset is approved and if so have a 'un-approve' item instead 
	 of 'approve'.  Make sure to update all the context menus in the document 
	 tree with an 'approve' item.
[ ]: add an unapprove_assets tool to the vn agent miroring approve_assets.

	 
