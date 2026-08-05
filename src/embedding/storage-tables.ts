import {
  chatMessageEmbeddings384,
  chatMessageEmbeddings768,
  chatMessageEmbeddings1024,
  chatMessageEmbeddings1536,
  chatMessageEmbeddings2048,
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  retrievalChunks1536,
  retrievalChunks2048,
} from "../database/schema.js";
import {
  EMBEDDING_DIMENSIONS,
  SUPPORTED_EMBEDDING_DIMENSIONS,
  type EmbeddingDimensions,
} from "./dimensions.js";

export type RetrievalVectorTable =
  | typeof retrievalChunks384
  | typeof retrievalChunks768
  | typeof retrievalChunks1024
  | typeof retrievalChunks1536
  | typeof retrievalChunks2048;

export type ChatMessageEmbeddingTable =
  | typeof chatMessageEmbeddings384
  | typeof chatMessageEmbeddings768
  | typeof chatMessageEmbeddings1024
  | typeof chatMessageEmbeddings1536
  | typeof chatMessageEmbeddings2048;

interface EmbeddingStorageSpecification {
  chatMessageTable: ChatMessageEmbeddingTable;
  retrievalTable: RetrievalVectorTable;
}

const EMBEDDING_STORAGE_SPECIFICATIONS = {
  [EMBEDDING_DIMENSIONS.DIMENSION_384]: {
    chatMessageTable: chatMessageEmbeddings384,
    retrievalTable: retrievalChunks384,
  },
  [EMBEDDING_DIMENSIONS.DIMENSION_768]: {
    chatMessageTable: chatMessageEmbeddings768,
    retrievalTable: retrievalChunks768,
  },
  [EMBEDDING_DIMENSIONS.DIMENSION_1024]: {
    chatMessageTable: chatMessageEmbeddings1024,
    retrievalTable: retrievalChunks1024,
  },
  [EMBEDDING_DIMENSIONS.DIMENSION_1536]: {
    chatMessageTable: chatMessageEmbeddings1536,
    retrievalTable: retrievalChunks1536,
  },
  [EMBEDDING_DIMENSIONS.DIMENSION_2048]: {
    chatMessageTable: chatMessageEmbeddings2048,
    retrievalTable: retrievalChunks2048,
  },
} as const satisfies Record<EmbeddingDimensions, EmbeddingStorageSpecification>;

export const RETRIEVAL_VECTOR_TABLES: readonly RetrievalVectorTable[] =
  SUPPORTED_EMBEDDING_DIMENSIONS.map((dimensions) => {
    return EMBEDDING_STORAGE_SPECIFICATIONS[dimensions].retrievalTable;
  });

export const CHAT_MESSAGE_EMBEDDING_TABLES: readonly ChatMessageEmbeddingTable[] =
  SUPPORTED_EMBEDDING_DIMENSIONS.map((dimensions) => {
    return EMBEDDING_STORAGE_SPECIFICATIONS[dimensions].chatMessageTable;
  });

export function readEmbeddingStorageSpecification(
  dimensions: EmbeddingDimensions,
): EmbeddingStorageSpecification {
  return EMBEDDING_STORAGE_SPECIFICATIONS[dimensions];
}

export function readRetrievalVectorTable(
  dimensions: EmbeddingDimensions,
): RetrievalVectorTable {
  return readEmbeddingStorageSpecification(dimensions).retrievalTable;
}

export function readChatMessageEmbeddingTable(
  dimensions: EmbeddingDimensions,
): ChatMessageEmbeddingTable {
  return readEmbeddingStorageSpecification(dimensions).chatMessageTable;
}
