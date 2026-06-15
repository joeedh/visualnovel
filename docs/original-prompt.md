 I'd like to make a visual novel generator.  Write a report on how this might work; the system should take a set of
  written character descriptions and optionally reference images for each character, a screenplay (remember that
  visual novels have branching screenplays), optionally descriptions of locations (if not provided they will be
  derived from the screenplay).  it should create a set of locations from any provided by the user and any in the
  screenplay and character descriptions, then write a detailed breakdown of each location in markdown files.  generative AI is then used to create reference shots of the locations.  the
  system would then generate images of the characters using generative AI (via a google gemini key the user provides).
  the user would refine then approve the look of each character, then detailed model sheets would be created also
  via generative AI showing the character from different vantage points.  these images would make up the 'default' set
  of clothing for the character; if later on different clothing is needed model ref images will be made for them too.
  to generate the final visual novel the system should split the screenplay into scenes, and those scenes into
  shots; each scene should be in a markdown file, and each 'shot' should be a description of the shot.  the system then refines the shot description into a prompt suitable for gemini nano banana and feeds it along with any needed model/location reference images to gemini.  the resulting image should be read back with both
  gemini and claude and double-checked for correctness, with the gemini prompt updated to fix errors.
  this iteration should happen no more then 4 times.
  
  to avoid duplicate generative ai work the system should build a global list of tasks and prune duplicates.  
  
  the report should propose possible directory layouts for both the input provided by the user and the generated visual novel data.   note: the actual final export to a visual novel engine is out of scope of the report.
  
  