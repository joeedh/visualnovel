[x]: add a rule to CLAUDE.md that all plans are to be pressure tested with an agent with a 
     fresh context after formulation.
[x]: rename coverage editor to 'shot coverage'
[x]: right clicking on a node in the branches editor should popup a context menu with 'go to script' that will show
     the story node in a script editor.
[x]: remove the 'clear' button in the convo editor.
[ ]: when the agent makes changes to shot coverage it should refresh the coverage editor
[ ]: the multichoice picking tool sometimes tells the agent 'no answer' when the user has 
     picked an option.
[ ]: make agent threads resumable.  the user should be given the option to compact the thread history;
     compaction will not modify the transcript but instead append the compacted history to it.  
	 create a tool for the agent to search the uncompacted history similar to how claude code 
	 does it.
[ ]: execute docs/plans/the-debug-agent-as-a-conversation.md
[ ]: overlapping notifications popup is still not fixed, you will have to run a headed 
     test and take screenshots yourself to fix it.  note it needs fairly long notification
	 text to happen.
[x]: the model api error card thingy should have 'stop and try and figure what went wrong'
     be the first option before the models.
[x]: the tokens counter's tooltip should be reworked so it's more readable for average users 
     instead of devs.
[ ]: the play editor isn't updated when new shows are created
[x]: use an agent to execute docs/plans/prompt-caching-for-the-report-analyst.md wait for it to finish
[ ]: the new install git hub workflow feature should tell the user how to enable the page on github 
     pages, looks like they have to navigate to the settings and select the gh-pages branch manually.
	 also if the user asks the agent how to do this it should be able to answer.
[ ]: the newShot agent tool apparently doesn't have a parameter for the cast/character[s] 
     add if that makes sense.
[x]: when the tasks editor pops up in a floating editor it should have 'only running'
     checkbox on.
[x]: clicking the pipeline stop button should also stop the recursive approve and generate
     loop if it doesn't already.
[x]: double checking a shot in the coverage editor should show the shots asset in
     the asset editor.  same with double clicking the shot in owning scene's subtree of 
	 shots in the document editor.
[x]: add a search bar to the document tree.  it should act as a filter for the tree.
[x]: alphabetically sort the assets subtrees in the document tree
[ ]: the regenerate button in the asset editor should not error if it cannot be 
     recreated in one task and inform the user to run the pipeline, instead it 
	 should pop up a dialog asking the user if they want to run the whole pipeline.
[x]: the 'x' icon in floating editors is too small
[ ]: the complete ux state should be saved in projects not just the layout,
     e.g. active assets scenes wikie pages etc.  this should be error-tolerant since the user 
	 may update the project repo on their own outside the desktop app.
[ ]: write a report on creating unit tests to test prompt caching.  they would 
     only be run when approved by the user and not part of pnpm test and use real api keys.  
	 both the vn agent and the debug agent would be tested.  one test for every supported 
	 model.
[x]: the story editor should show script line numbers
[ ]: right clicking a script line should popup a context menu with 'edit with agent' that 
     shows convo editor in a different screen area and creates a new thread if the current 
	 one isn't empty, and prefills it with the scene and line number.
[x]: assets that failed to generate should have a reason shown in the asset editor.
[x]: when an asset that failed after X attempts is changed (e.g. art notes, prompt changes)
     the pipeline should rerender it.
[x]: when an asset editor is showing the more recent asset of a slot, and the pipeline generates 
     a new asset for that slot, the editor should show the new asset automatically.
[ ]: the task graph should have a searchable list of asset slots, clicking one lets 
     you see just the graph uses to generate the slot.  it should arrange the nodes 
	 in a nice manner.
[ ]: the asset editor for failed shots should have a 'fix with agent' button 
     that shows the convo editor with a new thread (if current thread isn't empty)
	 and a prompt for the agent to fix the asset prefilled.
[ ]: do not use sugiyama layout for the global task graph view 
   - it might work for individual asset subgraphs, so use it for those and we'll try it.
[ ]: clicking on a scene should show it in any open play editors 
[ ]: clicking on a shot in the coverage editor (or the document tree) should show it in the play editor.
[ ]: write a report on supporting a manga or anime shot composition style, where 
     instead of portraits popping up on the screen (as light novels often do) 
	 each shot would fully frame characters.  cross reference with the ai shot 
	 framing report.
[ ]: see if the ai framing report includes methods that use generative ai to edit 
     reference shots and insert characters into them.  if not use an agent to research
	 that and add it to the report.
