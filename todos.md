[x]: add a rule to CLAUDE.md that all plans are to be pressure tested with an agent with a 
     fresh context after formulation.
[ ]: rename coverage editor to 'shot coverage'
[ ]: right clicking on a node in the branches editor should popup a context menu with 'go to script' that will show
     the story node in a script editor.
[ ]: remove the 'clear' button in the convo editor.
[ ]: when the agent makes changes to shot coverage it should refresh the coverage editor
[ ]: the multichoice picking tool sometimes tells the agent 'no answer' when the user has 
     picked an option.
[ ]: make agent threads resumable.  the user should be given the option to compact the thread history;
     compaction will not modify the transcript but instead append the compacted history to it.  
	 create a tool for the agent to search the uncompacted history similar to how claude code 
	 does it.
[ ]: give the report difficult agent dialog a field where the debug agent can report progress
     or other updates.
[ ]: also add a stop button to the report difficult agent dialog. 
[ ]: overlapping notifications popup is still not fixed, you will have to run a headed 
     test and take screenshots yourself to fix it.
[ ]: the model api error card thingy should have 'stop and try and figure what went wrong'
     be the first option before the models.
[ ]: the tokens counter's tooltip should be reworked so it's more readable for average users 
     instead of devs.