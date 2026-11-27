"""Game loop. Calls score-api over HTTP when a run ends."""
import httpx

from board.grid import Grid
from render.canvas import Canvas
from snake.snake import Snake


def play() -> int:
    grid = Grid(20, 12)
    snake = Snake((3, 6))
    canvas = Canvas(grid)
    score = 0
    food = grid.spawn_food(snake.body)
    for _ in range(40):
        snake.step()
        if grid.hits_wall(snake.head) or snake.hits_self():
            break
        if snake.head == food:
            snake.grow()
            score += 1
            food = grid.spawn_food(snake.body)
        canvas.frame(snake, food, score)
    httpx.post("http://score-api:8000/scores", json={"score": score})
    return score


if __name__ == "__main__":
    play()
