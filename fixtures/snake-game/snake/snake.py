class Snake:
    def __init__(self, start: tuple[int, int]) -> None:
        self.body = [start, (start[0] - 1, start[1])]
        self.direction = (1, 0)
        self._grow = 0

    @property
    def head(self) -> tuple[int, int]:
        return self.body[0]

    def step(self) -> None:
        nxt = (self.head[0] + self.direction[0], self.head[1] + self.direction[1])
        self.body.insert(0, nxt)
        if self._grow:
            self._grow -= 1
        else:
            self.body.pop()

    def grow(self) -> None:
        self._grow += 1

    def hits_self(self) -> bool:
        return self.head in self.body[1:]
