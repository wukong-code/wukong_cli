import agentYaml from './default/agent.yaml?raw';
import coderYaml from './default/coder.yaml?raw';
import exploreYaml from './default/explore.yaml?raw';
import freshReviewerMarkdown from './default/fresh-reviewer.md?raw';
import freshReviewerYaml from './default/fresh-reviewer.yaml?raw';
import initMd from './default/init.md?raw';
import planYaml from './default/plan.yaml?raw';
import reviewerYaml from './default/reviewer.yaml?raw';
import strategistYaml from './default/strategist.yaml?raw';
import systemMd from './default/system.md?raw';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/fresh-reviewer.yaml': freshReviewerYaml,
  'profile/default/fresh-reviewer.md': freshReviewerMarkdown,
  'profile/default/plan.yaml': planYaml,
  'profile/default/reviewer.yaml': reviewerYaml,
  'profile/default/strategist.yaml': strategistYaml,
  'profile/default/system.md': systemMd,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  ['agent.yaml', 'coder.yaml', 'explore.yaml', 'fresh-reviewer.yaml', 'reviewer.yaml', 'strategist.yaml', 'plan.yaml'].map(
    (file) => `profile/default/${file}`,
  ),
  PROFILE_SOURCES,
);
