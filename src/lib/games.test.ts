import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllCategories,
    getAllGames,
    getAllGameIds,
    getAllPublishers,
    getGameById,
    getGames,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all category and publisher choices in display order', async () => {
        await db.insert(categories).values([
            { name: 'Strategy', description: 'cat' },
            { name: 'Adventure', description: 'cat' },
        ]);
        await db.insert(publishers).values([
            { name: 'Pub Two', description: 'pub' },
            { name: 'Pub One', description: 'pub' },
        ]);

        expect((await getAllCategories(db)).map((category) => category.name)).toEqual(['Adventure', 'Strategy']);
        expect((await getAllPublishers(db)).map((publisher) => publisher.name)).toEqual(['Pub One', 'Pub Two']);
    });

    it('filters games by category', async () => {
        const [strategy] = await db
            .insert(categories)
            .values({ name: 'Strategy', description: 'cat' })
            .returning({ id: categories.id });
        const [adventure] = await db
            .insert(categories)
            .values({ name: 'Adventure', description: 'cat' })
            .returning({ id: categories.id });
        const [pubOne] = await db
            .insert(publishers)
            .values({ name: 'Pub One', description: 'pub' })
            .returning({ id: publishers.id });
        const [pubTwo] = await db
            .insert(publishers)
            .values({ name: 'Pub Two', description: 'pub' })
            .returning({ id: publishers.id });

        await db.insert(games).values([
            { title: 'Game 01', description: 'Desc 1', starRating: 4.2, categoryId: strategy.id, publisherId: pubOne.id },
            { title: 'Game 02', description: 'Desc 2', starRating: 4.5, categoryId: strategy.id, publisherId: pubTwo.id },
            { title: 'Game 03', description: 'Desc 3', starRating: 3.9, categoryId: adventure.id, publisherId: pubOne.id },
        ]);

        const filtered = await getGames(db, { categoryIds: [strategy.id] });
        expect(filtered.map((game) => game.title)).toEqual(['Game 01', 'Game 02']);
    });

    it('filters games by publisher and supports combined category + publisher filters', async () => {
        const [strategy] = await db
            .insert(categories)
            .values({ name: 'Strategy', description: 'cat' })
            .returning({ id: categories.id });
        const [adventure] = await db
            .insert(categories)
            .values({ name: 'Adventure', description: 'cat' })
            .returning({ id: categories.id });
        const [pubOne] = await db
            .insert(publishers)
            .values({ name: 'Pub One', description: 'pub' })
            .returning({ id: publishers.id });
        const [pubTwo] = await db
            .insert(publishers)
            .values({ name: 'Pub Two', description: 'pub' })
            .returning({ id: publishers.id });

        await db.insert(games).values([
            { title: 'Game 01', description: 'Desc 1', starRating: 4.2, categoryId: strategy.id, publisherId: pubOne.id },
            { title: 'Game 02', description: 'Desc 2', starRating: 4.5, categoryId: strategy.id, publisherId: pubTwo.id },
            { title: 'Game 03', description: 'Desc 3', starRating: 3.9, categoryId: adventure.id, publisherId: pubOne.id },
        ]);

        expect((await getGames(db, { publisherId: pubTwo.id })).map((game) => game.title)).toEqual(['Game 02']);
        expect((await getGames(db, { categoryIds: [strategy.id], publisherId: pubTwo.id })).map((game) => game.title)).toEqual([
            'Game 02',
        ]);
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});
