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
[ ]: execute docs/plans/watching-and-stopping-an-agent-report.md -- progress and a stop button
     for the report difficult agent dialog (the two items above), plus the fallback bug a stop
     exposes: analyze() reads a stopped loop as one that never filed, so Stop would spend
     another model call and hand back a report that was cancelled.  pressure test the plan
     with a fresh-context agent first.
[ ]: the report difficult agent dialog should be clearer about the user needing to paste 
     the detailed report at the end, use red or yellow text for this.
[ ]: the play editor isn't updated when new shows are created
[ ]: use an agent to execute docs/plans/prompt-caching-for-the-report-analyst.md wait for it to finish
[ ]: the new install git hub workflow feature should tell the user how to enable the page on github 
     pages, looks like they have to navigate to the settings and select the gh-pages branch manually.
	 also if the user asks the agent how to do this it should be able to answer.
