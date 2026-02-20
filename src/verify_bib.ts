import fs from 'fs';
import path from 'path';
import { searchSemanticScholar, searchDblp } from './utils/bibtex';

const bibPath = '/Users/hanxiao/Documents/vision-encoder/latex/references.bib';

// Robust BibTeX parser handling nested braces
function parseBibtex(content: string) {
    const entries: any[] = [];
    const entryHeaderRegex = /@(\w+)\s*{\s*([^,]+),/g;
    
    let match;
    while ((match = entryHeaderRegex.exec(content)) !== null) {
        const type = match[1];
        const key = match[2].trim();
        const startIndex = match.index;
        
        // Find the end of the entry (balanced braces)
        let braceCount = 0;
        let endIndex = -1;
        let foundStart = false;
        
        for (let i = startIndex; i < content.length; i++) {
            if (content[i] === '{') {
                braceCount++;
                foundStart = true;
            } else if (content[i] === '}') {
                braceCount--;
            }
            
            if (foundStart && braceCount === 0) {
                endIndex = i;
                break;
            }
        }
        
        if (endIndex === -1) continue; // Malformed entry
        
        const body = content.substring(match.index + match[0].length, endIndex);
        
        // Parse fields
        const title = extractField(body, 'title');
        const yearStr = extractField(body, 'year');
        const authorStr = extractField(body, 'author');
        
        const year = yearStr ? parseInt(yearStr) : undefined;
        const authors = authorStr ? authorStr.split(/\s+and\s+/i).map(a => a.trim().replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ')) : [];
        
        if (title) {
            entries.push({ type, key, title, year, authors });
        }
    }
    return entries;
}

function extractField(body: string, fieldName: string): string | null {
    // Regex to find "field = {" or "field={"
    const fieldRegex = new RegExp(`${fieldName}\\s*=\\s*`, 'i');
    const match = fieldRegex.exec(body);
    if (!match) return null;
    
    const startIdx = match.index + match[0].length;
    let value = '';
    
    if (body[startIdx] === '{') {
        // Braced value: capture until balanced closing brace
        let depth = 0;
        for (let i = startIdx; i < body.length; i++) {
            const char = body[i];
            if (char === '{') depth++;
            else if (char === '}') depth--;
            
            if (depth === 0) {
                // remove surrounding braces
                value = body.substring(startIdx + 1, i); 
                break;
            }
        }
    } else if (body[startIdx] === '"') {
        // Quoted value
        const endQuote = body.indexOf('"', startIdx + 1);
        if (endQuote !== -1) value = body.substring(startIdx + 1, endQuote);
    } else {
        // Unquoted value (digits or string)
        const endComma = body.indexOf(',', startIdx);
        const endLine = body.indexOf('\n', startIdx);
        let end = body.length;
        if (endComma !== -1 && endComma < end) end = endComma;
        if (endLine !== -1 && endLine < end) end = endLine;
        value = body.substring(startIdx, end);
    }
    
    // Clean up braces inside the value (e.g. {PaLI})
    return value.replace(/[{}]/g, '').replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
	if (wordsA.size === 0 || wordsB.size === 0) return 0;
	let intersection = 0;
	for (const word of wordsA) if (wordsB.has(word)) intersection++;
	return intersection / Math.max(wordsA.size, wordsB.size);
}

function checkDetails(local: any, remote: any) {
    if (local.year && remote.year && Math.abs(local.year - remote.year) > 1) {
        console.log(`    ⚠️ Year mismatch: Local ${local.year} vs Remote ${remote.year}`);
    }
    
    if (local.authors.length > 0 && remote.authors.length > 0) {
        const getSurname = (name: string) => {
             const parts = name.split(',').map(s => s.trim());
             if (parts.length > 1) return parts[0]; 
             const spaceParts = name.split(/\s+/);
             return spaceParts[spaceParts.length - 1];
        };

        const localSurname = getSurname(local.authors[0]).toLowerCase();
        const remoteSurname = getSurname(remote.authors[0]).toLowerCase();
        
        if (!localSurname.includes(remoteSurname) && !remoteSurname.includes(localSurname)) {
             console.log(`    ⚠️ First author mismatch? Local: ${local.authors[0]} vs Remote: ${remote.authors[0]}`);
        }
    }
}

async function verify() {
    if (!fs.existsSync(bibPath)) {
        console.error(`File not found: ${bibPath}`);
        return;
    }
    
    const content = fs.readFileSync(bibPath, 'utf-8');
    const entries = parseBibtex(content);
    console.log(`Found ${entries.length} entries in ${bibPath}`);
    
    let hallucinations = 0;
    
    // Whitelist manually verified entries
    const whitelist = new Set(['simeoni2025dinov3']); 

    for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);
        await Promise.all(batch.map(async (entry) => {
            if (whitelist.has(entry.key)) return;

            try {
                // DBLP first
                let match = null;
                const dblp = await searchDblp({ query: entry.title, num: 1 });
                if (dblp.length > 0 && similarity(entry.title, dblp[0].title) > 0.8) {
                    match = dblp[0];
                } else {
                    // S2 fallback
                    const results = await searchSemanticScholar({ query: entry.title, num: 1 });
                    if (results.length > 0 && similarity(entry.title, results[0].title) > 0.8) {
                        match = results[0];
                    }
                }

                if (match) {
                    checkDetails(entry, match);
                } else {
                    console.log(`❌ [${entry.key}] NOT FOUND or Low Similarity`);
                    console.log(`   Local Title: ${entry.title}`);
                    hallucinations++;
                }
            } catch (e) {
                console.log(`ERROR [${entry.key}]: ${e}`);
            }
        }));
        await new Promise(r => setTimeout(r, 1200)); 
    }
    
    console.log(`\nDone. ${hallucinations} remaining potential hallucinations.`);
}

verify();
