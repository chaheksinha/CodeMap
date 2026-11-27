import random


class Grid:
    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height

    def hits_wall(self, point: tuple[int, int]) -> bool:
        x, y = point
        return x < 0 or y < 0 or x >= self.width or y >= self.height

    def cells(self) -> list[tuple[int, int]]:
        return [(x, y) for y in range(self.height) for x in range(self.width)]

    def spawn_food(self, avoid: list[tuple[int, int]]) -> tuple[int, int]:
        blocked = set(avoid)
        open_cells = [cell for cell in self.cells() if cell not in blocked]
        return random.choice(open_cells)
