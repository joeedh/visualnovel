[ ]: pressing ctrl +/- should increase/decrease text size 
     (presumably via whatever api electron exposes to alter devicePixelRatio?).
[ ]: review the text in the run pipeline dialog.
[ ]: make sure the debug agent editor has text warning the user about 
     token cost.
[ ]: typing '/' in the convo editor should show available skills with proper 
     autocomplete semantics
[ ]: create a system where we can have default skills for the vn agent  that 
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