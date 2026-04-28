/**
 * StreamRegistry — re-exports from stardb with tracesdb's Chunk type.
 *
 * The generic StreamRegistry<C> lives in stardb. This module provides
 * a typed subclass so existing imports continue to work unchanged.
 */

import { StreamRegistry as GenericStreamRegistry } from "stardb";
import type { Chunk } from "./chunk.js";

export class StreamRegistry extends GenericStreamRegistry<Chunk> {}
