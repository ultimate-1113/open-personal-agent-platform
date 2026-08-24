export type EchoInput = { text: string };

export const echo = (input: EchoInput): EchoInput => ({ text: input.text });
