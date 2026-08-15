export interface paths {
    "/v1/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["queryKnowledge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/mcp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["mcp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    queryKnowledge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    sourceId: string;
                    query: string;
                    /**
                     * @default search
                     * @enum {string}
                     */
                    mode: "search" | "answer";
                    /** @default 5 */
                    maxSources: number;
                };
            };
        };
        responses: {
            /** @description Knowledge results */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        mode: "search";
                        results: {
                            sourceId: string;
                            resourceId: string;
                            title: string;
                            /** Format: uri */
                            uri: string;
                            /** Format: date-time */
                            observedAt: string;
                            excerpt: string;
                            observationId: string;
                        }[];
                    } | {
                        /** @constant */
                        mode: "answer";
                        answer: string;
                        citations: {
                            sourceId: string;
                            resourceId: string;
                            title: string;
                            /** Format: uri */
                            uri: string;
                            /** Format: date-time */
                            observedAt: string;
                            excerpt: string;
                            observationId: string;
                        }[];
                        observationId: string;
                        model: {
                            providerId: string;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
            /** @description Policy denied */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
            /** @description Source not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
            /** @description Budget limit */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
            /** @description Invalid source result */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
            /** @description Source or metering unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        /** Format: uri */
                        type: string;
                        title: string;
                        status: number;
                        requestId: string;
                        errors?: unknown;
                    };
                };
            };
        };
    };
    listCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Capabilities */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    mcp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stateless Streamable HTTP MCP response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
