#!/usr/bin/env python3
"""Python 3 starter — AgentFlow IDE"""

from typing import List, Optional
import json


def greet(name: str) -> str:
    return f"Hello, {name}!"


def factorial(n: int) -> int:
    if n <= 1:
        return 1
    return n * factorial(n - 1)


class Person:
    def __init__(self, name: str, age: int):
        self.name = name
        self.age = age

    def __repr__(self) -> str:
        return f"Person(name={self.name!r}, age={self.age})"

    def to_dict(self) -> dict:
        return {"name": self.name, "age": self.age}


def main():
    print(greet("World"))
    print(f"10! = {factorial(10)}")
    people: List[Person] = [Person("Alice", 30), Person("Bob", 25)]
    for p in people:
        print(json.dumps(p.to_dict(), indent=2))


if __name__ == "__main__":
    main()
