[ ]: Clicking an asset in a popped up tasks window should be able to set the active asset to it and open it 
     in an asset editor.
[ ]: changing the token budget doesn't update its dropdown menu until the agent runs.
[ ]: pathux's help picker should not close a tooltip on pointer up if triggered by multitouch.
     it should instead register a global pointer down handler to close it (don't 
	 block the pointer down going to its other consumers).  there should be a backup timer 
	 to close the tooltip after 30 seconds.  in the multitouch case the user's own finger 
	 can block the tooltip.
[ ]: clicking a project in the recent projects menu doesn't open it

## Command Macro Report
[x]: write a report on the pros and cons of giving the agent full access to the ux command system.
     the following assumes we won't be doing that.  read the guided ux tours plan for context.  
[ ]: write a report on the potential for letting the user hook custom actions into various bits of the UX:
     A custom action is a traditional tool command macro, which includes a new tool to invoke the agent.
	 At the moment we don't have any bridge between the agent and UX commands, and this is likely desirable. 
	 Open questions:
	 [ ]: The ux affordance to indicate a macro is executing to the user.  Since macros can involve agent calls 
	      they can be asyncrounous, and locking the whole UX will not always be feasible for if the agent 
		  needs to ask the user a question.
	 [ ]: File format macros are stored in.  Should be text based and easily readable, user will have the option
	      to save macros to either their user folder or commit them into the project repo.  If saved in the user 
		  settings we should git init a little repo so we can version them.  
	 [ ]: investigate a selection-first workflow ('select this', 'do that on selection') vs adding 
	      full output properties to commands ('pick this' -> 'do that on input').
     [ ]: the user should be able to use an agent to create these macros.  we might need to create a subagent 
	      system for this; e.g. the user would say 'create a macro bleh bleh' the agent would fork into a subagent
		  that's specialized for macros, on completion it would ask the user if they want to return to their prior
		  conversation.  there'd be UX for navigating the hierachy of subagents.
		  - alternatively we could design model tools for the agent to load context/tools specialized for 
		    macro building macros.
	[ ]: would we need to bridge the agent and the ux here.  a macro writing agent in principle only writes 
	     text files, and presumably the button to preview them would be in the subagent UX.
	[ ]: there is a guided ux tours plan btw, check how it fits into all this.
	[ ]: would be nice to have a 'preview' mode.  would it be better to use the user's existing repo for 
		 this and revert via git on cancel, or should we clone the project repo (and the wiki bible repo 
		 when we eventually support separate wiki repos).
	[ ]: how would preview mode deal with the pipeline.  while we could have a mock pipeline, the user 
		 will want to run the real thing in some cases.  perhaps there could be a 'dry-run only' option
		 for preview.
	[ ]: a dialog with unset tool inputs will be shown to the user on macro invocation?
	[ ]: user will need a way to upload macros (to either their user folder or project repo), 
	     export them, copy macros from their user folder to the project repo for specialization, 
		 etc.		 
	     
	
### Macro Editor 
  * Will not be implemented immediately 
  * Should let users connect tool outputs to tool inputs, set values for tool inputs, etc.
  * the user will have the option to hide some of these in the macro popup dialog in favor of defaults.
  * user can create macro input property nodes that show up in the macro dialog 
   - with an option to hide these in the dialog if they're just e.g. constants.
  * the DAG can only have one root tool node.  a root tool node is one whose parents 
	only contain input nodes.
	
### Feature Goals 
  * All context menus have '...add macro' and '...create new macro' items. 
  * Right-clicking on context menu items lets you change their order
    - Presumably this will require a generic context menu builder system.
	  Macros could have metadata with context menu insertions.
	- A context menu builder system would need to be either dynamic enough 
	  we aren't saving the menu items directly on list, or be able to deal 
	  with merge policies.
	- If we have the context menu builder store metadata exclusively inside Macro
	  themselves a lot of desirable behaviour might come out of it:
	  - Users can create standard context menu layouts at a project repo level.
	  - Project context menus would not conflict with user ones, they would be 
	    merged together.  If identical macros exist in both places only one will
		be shown in the menu, if names match but they're not identical the names 
		will have (Project) and (User) appended to them.
	- Presumably macros would have a sort priority field.  Adding a macro would also 
	  append it at the end with a unique sort priority, indentical sort keys 
	  would be fall back to lexographic sorting of their names.
	- Reordering context menu items could be done with non-integer floating point 
	  values to avoid updating all the macros in the context menu.
	

	  