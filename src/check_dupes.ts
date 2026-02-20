import fs from 'fs';

const bibPath = '/Users/hanxiao/Documents/vision-encoder/latex/references.bib';

function normalize(str: string) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseBibtex(content: string) {
    const entries: any[] = [];
    const entryRegex = /@(\w+)\s*{\s*([^,]+),([^@]+)}/g;
    let match;
    while ((match = entryRegex.exec(content)) !== null) {
        const type = match[1];
        const key = match[2].trim();
        const body = match[3];
        
        const titleMatch = body.match(/title\s*=\s*{+([^}]+)}+/i);
        const title = titleMatch ? titleMatch[1].replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim() : '';
        
        const arxivMatch = body.match(/arXiv:(\d+\.\d+)/i) || body.match(/eprint\s*=\s*{?(\d+\.\d+)}?/i);
        const arxiv = arxivMatch ? arxivMatch[1] : null;

        if (title) {
            entries.push({ key, title, arxiv, raw: match[0] });
        }
    }
    return entries;
}

function similarity(a: string, b: string): number {
    const s1 = a.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const s2 = b.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const wordsA = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    
    let intersection = 0;
    for (const word of wordsA) if (wordsB.has(word)) intersection++;
    
    return intersection / Math.min(wordsA.size, wordsB.size); // Changed to min for better detection of subsets
}

function checkDupes() {
    if (!fs.existsSync(bibPath)) {
        console.error(`File not found: ${bibPath}`);
        return;
    }
    
    const content = fs.readFileSync(bibPath, 'utf-8');
    const entries = parseBibtex(content);
    console.log(`Checking ${entries.length} entries for duplicates...`);
    
    const potentialDupes: Set<string> = new Set();
    const seenTitles = new Map<string, string>(); // normalizedTitle -> key
    const seenArxiv = new Map<string, string>(); // arxivId -> key

    // 1. Strict Normalized Title Check
    for (const entry of entries) {
        const norm = normalize(entry.title);
        if (norm.length < 10) continue; // Skip very short titles

        if (seenTitles.has(norm)) {
            const existingKey = seenTitles.get(norm);
            potentialDupes.add(`${existingKey} <==> ${entry.key} (Same Title)`);
        } else {
            seenTitles.set(norm, entry.key);
        }

        if (entry.arxiv) {
             if (seenArxiv.has(entry.arxiv)) {
                const existingKey = seenArxiv.get(entry.arxiv);
                potentialDupes.add(`${existingKey} <==> ${entry.key} (Same arXiv ID: ${entry.arxiv})`);
            } else {
                seenArxiv.set(entry.arxiv, entry.key);
            }
        }
    }

    // 2. Fuzzy Check (O(N^2) but N is small ~100)
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i];
            const b = entries[j];
            
            // Skip if already flagged
            if (normalize(a.title) === normalize(b.title)) continue;

            const sim = similarity(a.title, b.title);
            if (sim > 0.85) {
                potentialDupes.add(`${a.key} <==> ${b.key} (Sim: ${sim.toFixed(2)})\n   "${a.title}"\n   "${b.title}"`);
            }
        }
    }

    if (potentialDupes.size === 0) {
        console.log("✅ No duplicates found.");
    } else {
        console.log(`⚠️ Found ${potentialDupes.size} potential duplicate pairs:`);
        potentialDupes.forEach(d => console.log(`- ${d}`));
    }
}

checkDupes();
