import { OpenAI } from 'openai';
import {
    Agent,
    handoff,
    OpenAIChatCompletionsModel,
    run,
    setDefaultOpenAIClient,
    tool,
    InputGuardrailTripwireTriggered,
    type RunContext,
    type InputGuardrail,
} from '@openai/agents';
import { z } from 'zod';

const EscalationData = z.object({ reason: z.string() });
type EscalationData = z.infer<typeof EscalationData>;

const pokemonTool = tool({
    name: 'pokemon_info',
    description: 'Get information about a Pokémon by name or ID',
    parameters: z.object({
        pokemon: z
            .string()
            .describe('The name or ID of the Pokémon to look up'),
    }),
    execute: async ({ pokemon }) => {
        console.log(`Looking up Pokémon: ${pokemon}`);
        return `${pokemon} is a Pokémon. I'll provide more details from my own knowledge.`;
    },
});

const client = new OpenAI({
    apiKey:
        process.env.NODE_ENV === 'development'
            ? process.env.LOCAL_LLM_KEY
            : undefined,
    baseURL:
        process.env.NODE_ENV === 'development'
            ? process.env.LOCAL_LLM_URL!
            : undefined,
});

setDefaultOpenAIClient(client);

const model =
    process.env.NODE_ENV === 'development'
        ? new OpenAIChatCompletionsModel(client, process.env.LOCAL_LLM_MODEL!)
        : process.env.LOCAL_LLM_MODEL!;

const guardrailAgent = new Agent({
    name: 'Guardrail check',
    instructions:
        'We sell pillows. If the input is remotely about pillows return isNotAboutPillows: false, otherwise return true.',
    model,
    outputType: z.object({
        isNotAboutPillows: z.boolean(),
        reasoning: z.string(),
    }),
});

const pillowGuardrails: InputGuardrail = {
    name: 'Pillow Customer Support Guardrail',
    execute: async ({ input, context }) => {
        const result = await run(guardrailAgent, input, { context });
        return {
            outputInfo: result.finalOutput,
            tripwireTriggered: result.finalOutput?.isNotAboutPillows ?? false,
        };
    },
};
const customerSupportAgent = new Agent({
    name: 'Customer Support Agent',
    instructions: `You are a customer support agent in a company that sells very fluffy pillows. 
                Be friendly, helpful. and concise.`,
    model,
});
const escalationControlAgent = new Agent({
    name: 'Escalation Control Agent',
    instructions: `You are an escalation control agent that handles negative customer interactions. 
            If the customer is upset, you will apologize and offer to escalate the issue to a manager.
            Be friendly, helpful, reassuring and concise.`,
    model,
});

const triageAgent = Agent.create({
    name: 'Triage Agent',
    instructions: `NEVER answer non-pillow related questions. 
        If the question is about pillows, route it to the customer support agent. 
        If the customer's tone is negative, route it to the escalation control agent.
        `,
    model,
    inputGuardrails: [pillowGuardrails],
    handoffs: [
        customerSupportAgent,
        handoff(escalationControlAgent, {
            inputType: EscalationData,
            onHandoff: async (
                ctx: RunContext<EscalationData>,
                input: EscalationData | undefined,
            ) => {
                console.log(
                    `Handoff to Escalation Control Agent: ${input?.reason}`,
                );
            },
        }),
    ],
});

try {
    // Run the agent with a specific task
    const result = await run(triageAgent, 'What is the meaning of life?');
    // Log the final output of the agent
    console.log(result.finalOutput);
} catch (error: unknown) {
    if (error instanceof InputGuardrailTripwireTriggered) {
        console.log(
            'Customer is not asking about pillows, or the input is not valid for the guardrail.',
        );
    } else {
        console.error('An error occurred:', error);
    }
}
