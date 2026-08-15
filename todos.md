[x]: create a system for clicking on document tree items to automatically show the associated editor.
     give each editor class a static method to test if a document reference is valid for it, it should return
	 a relevence score (e.g. for wiki pages the wiki editor gives the highest score).  
	 all instantiated editor tabs should be searched, and the (valid) one with the higher relevence score 
	 selected.  note that visible editors always have higher relevence then inactive ones.
	 if no editor is found the largest screen area that's not where the user clicked on should be selected 
	 and the editor with the highest relevence score created.
[x]: the wiki editor for a page should show assets that reference it.  we may need a generic cross-reference 
     asset viewer widget, that way we can reuse it in other places like the script editor.
[ ]: create main menu entries to open a project repo, as well as a command to create a new repo.  creating
     a new repo should also open it.
[ ]: create a /upload command for the agent that lets the user select files to upload.  the agent 
	 will automatically switch to plan mode and ask the user what to do with the files.  to start with we
	 will only support text files, but eventually the plan is to also support zip files, word documents,
	 and possible openoffice writer files (but that's long term).  btw when importing files, the agent should
	 always commit the original files to the repo in a special archive folder that's not indexable or searchable 
	 by the agent unless requested by the user.  if necassary we could commit them to the git history and delete
	 the files in another commit.
[ ]: the /upload command should, on importing files, give suggestions to the user (not based on the file contents)
     on how to write the next use prompt, e.g. 'what should I do with these (e.g. 'integrate into the wiki').	 
[ ]: create a main menu item to import files.  it will activate or create a conversation editor in a new thread, 
     autofill it with an /upload command and visually highlight the conversation editor somehow (briefly flashing border?).
[ ]: create the concept of conversation threads if it doesn't exist already.  there should be a searchable dropdown
     menu of all past threads.  we will be saving the thread transcripts (minus tool calls? your call) in project 
	 repo in an appropriate place (propose one).
[ ]: the asset editor should have an option to upload a custom asset for if e.g. a user pays someone to clean up
     artwork.
[ ]: if the agent is told to change an artwork asset it should have the tools not just to append to the art notes 
     but also to ask the user if it can regenerate it, and if so read back the image and propose further changes to the art
	 notes to get the desired results.

## document tree item right click menus:
[ ]: right clicking on a location should pop up a menu including an option to create a new reference shot asset.
     it should open the asset editor automatically.
[ ]: right clicking on the top level wiki tree should include a menu item to create a new wiki page.
[ ]: right clicking on an asset item should pop up a menu including 'regenerate' 'accept' 'reject' etc.  
     it should open the asset editor automatically for that asset.
