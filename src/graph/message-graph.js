/**
 * MessageGraph — a StateGraph specialized for message-passing agents.
 *
 * State is always `{ messages: BaseMessage[] }`. Nodes receive the
 * current messages array and return new messages to append — they don't
 * need to manage the full state object.
 *
 * This is the natural fit for the planning loop where every step
 * (clarify, plan, execute) is a conversational exchange:
 *
 *   const graph = new MessageGraph();
 *
 *   graph
 *     .addNode('clarify', async (messages, config) => {
 *       const response = await llm.invoke(messages);
 *       return response;                    // returns AIMessage or string
 *     })
 *     .addNode('plan', async (messages, config) => {
 *       const response = await llm.invoke(messages);
 *       return response;
 *     })
 *     .addConditionalEdges('clarify', (messages) => {
 *       const last = messages.at(-1);
 *       return last.content.includes('?') ? 'clarify' : 'plan';
 *     })
 *     .addEdge('plan', END)
 *     .setEntryPoint('clarify');
 *
 *   const compiled = graph.compile();
 *
 *   // Initial state is just the messages array
 *   const finalState = await compiled.invoke({
 *     messages: [new HumanMessage('My lawn mower won\'t start')]
 *   });
 *   // finalState.messages contains the full conversation
 *
 * Node return values are flexible:
 *   - BaseMessage instance → appended directly
 *   - string              → wrapped in AIMessage and appended
 *   - BaseMessage[]       → all appended
 *   - null / undefined    → no new messages (useful for pass-through nodes)
 *
 * Conditional edge functions receive the messages array (not the full
 * state object) for a simpler API.
 *
 * @module src/graph/message-graph.js
 */

import { StateGraph, END, START }  from './state-graph.js';
import { AIMessage, BaseMessage }  from '../core/message.js';

export { END, START };

export class MessageGraph extends StateGraph {
  constructor() {
    super({ stateSchema: { messages: [] } });
  }

  /**
   * Add a message-centric node.
   *
   * fn receives the messages array and returns new message(s) to append.
   *
   * @param {string}   name
   * @param {Function} fn   - async (messages: BaseMessage[], config?) =>
   *                            BaseMessage | BaseMessage[] | string | null
   * @returns {this}
   */
  addNode(name, fn) {
    const wrappedFn = async (state, config) => {
      const result = await fn(state.messages, config);

      if (result == null) return null;

      // Normalise: string → AIMessage, single message → array
      let newMessages;
      if (typeof result === 'string') {
        newMessages = [new AIMessage(result)];
      } else if (Array.isArray(result)) {
        newMessages = result;
      } else if (result instanceof BaseMessage) {
        newMessages = [result];
      } else {
        // Assume it's an AIMessage-like object with a .content property
        newMessages = [result];
      }

      return { messages: [...state.messages, ...newMessages] };
    };

    return super.addNode(name, wrappedFn);
  }

  /**
   * Add a conditional edge where the condition function receives the
   * messages array instead of the full state object.
   *
   * @param {string}      from
   * @param {Function}    conditionFn - (messages: BaseMessage[]) => nextNodeName | END
   * @param {object|null} [pathMap]
   * @returns {this}
   */
  addConditionalEdges(from, conditionFn, pathMap = null) {
    const wrappedCondition = (state) => conditionFn(state.messages);
    return super.addConditionalEdges(from, wrappedCondition, pathMap);
  }
}

export default MessageGraph;
