/**
 * Find similar terms based on substring matching of the first 3 characters.
 */
export function findSimilarTerms(
  term: string,
  candidates: string[],
  maxResults: number = 3
): string[] {
  if (term.length < 3) {
    return [];
  }

  const searchTerm = term.toLowerCase().substring(0, 3);
  return candidates
    .filter((candidate) => candidate.toLowerCase().includes(searchTerm))
    .slice(0, maxResults);
}
