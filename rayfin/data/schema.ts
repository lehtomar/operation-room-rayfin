import { Todo } from './Todo.js';
import { Crew } from './Crew.js';
import { Incident } from './Incident.js';
import { Assignment } from './Assignment.js';
import { GridEvent } from './GridEvent.js';
import { ScenarioState } from './ScenarioState.js';

export type AppSchema = {
  Todo: Todo;
  Crew: Crew;
  Incident: Incident;
  Assignment: Assignment;
  GridEvent: GridEvent;
  ScenarioState: ScenarioState;
};

// Back-compat alias for the initial scaffold imports.
export type TodoAppSchema = AppSchema;

export const schema = [Todo, Crew, Incident, Assignment, GridEvent, ScenarioState];
