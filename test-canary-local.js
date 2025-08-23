const { generateProcessingStatsTable } = require('./cdk.out/asset.../index.js');

// Sample data to test table generation
const sampleDocumentStats = [
  {
    document_id: 'doc-1',
    original_filename: 'sample-document.pdf',
    word_count: 1250,
    character_count: 7800,
    file_size: 245760,
    status: 'PROCESSED',
    chunk_count: 5,
    embeddings_created: 5,
    embeddings_stored: 5,
    avg_chunk_words: 250,
    min_chunk_words: 180,
    max_chunk_words: 320
  },
  {
    document_id: 'doc-2', 
    original_filename: 'test-content.txt',
    word_count: 450,
    character_count: 2900,
    file_size: 12288,
    status: 'PROCESSED',
    chunk_count: 2,
    embeddings_created: 2,
    embeddings_stored: 2,
    avg_chunk_words: 225,
    min_chunk_words: 200,
    max_chunk_words: 250
  },
  {
    document_id: 'doc-3',
    original_filename: 'web-scraped-content.html', 
    word_count: 890,
    character_count: 5400,
    file_size: 89600,
    status: 'PROCESSED',
    chunk_count: 3,
    embeddings_created: 3,
    embeddings_stored: 3,
    avg_chunk_words: 297,
    min_chunk_words: 280,
    max_chunk_words: 310
  }
];

console.log('=== TESTING CANARY TABLE GENERATION ===');
console.log(generateProcessingStatsTable(sampleDocumentStats));