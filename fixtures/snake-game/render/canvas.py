from board.grid import Grid
from snake.snake import Snake


class Canvas:
    def __init__(self, grid: Grid) -> None:
        self.grid = grid

    def frame(self, snake: Snake, food: tuple[int, int], score: int) -> None:
        print(f"score={score} head={snake.head} food={food} size={self.grid.width}x{self.grid.height}")
