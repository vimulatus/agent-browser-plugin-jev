/** The command's name. Usage, stderr lines, temp directories and the state directory all read it. */
export const NAME = "soab";

/** Where a scope keeps its state: `./.soab/` in a project, `~/.soab/` globally. */
export const STATE_DIR = `.${NAME}`;
